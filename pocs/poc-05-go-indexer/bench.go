package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

func procKB(key string) float64 {
	b, _ := os.ReadFile("/proc/self/status")
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, key) {
			f := strings.Fields(l)
			if len(f) > 1 {
				v, _ := strconv.ParseFloat(f[1], 64)
				return v
			}
		}
	}
	return 0
}

func cpuTicks() uint64 {
	b, _ := os.ReadFile("/proc/self/stat")
	s := string(b)
	f := strings.Fields(s[strings.LastIndex(s, ")")+1:])
	if len(f) < 13 {
		return 0
	}
	u, _ := strconv.ParseUint(f[11], 10, 64)
	k, _ := strconv.ParseUint(f[12], 10, 64)
	return u + k
}

func body(f, rev int) string {
	var s strings.Builder
	if f > 0 {
		fmt.Fprintf(&s, "import { fn%d_0 } from \"./m%d\";\n", f-1, f-1)
	}
	for i := 0; i < 5; i++ {
		if i == 0 {
			fmt.Fprintf(&s, "// @ref ADR-%03d\n", f%10+1)
		}
		tail := "return b;"
		if f > 0 && i == 0 {
			tail = fmt.Sprintf("return fn%d_0(b);", f-1)
		}
		fmt.Fprintf(&s, "export function fn%d_%d(x: number): number {\n  const a = x + %d + %d;\n  const b = a * 2;\n  if (b > 10) {\n    return b - 1;\n  }\n  %s\n}\n\n", f, i, i, rev, tail)
	}
	return s.String()
}

func pct(v []float64, p float64) float64 {
	sort.Float64s(v)
	i := int(float64(len(v)) * p)
	if i >= len(v) {
		i = len(v) - 1
	}
	return v[i]
}

// Same scenario as the Rust and Bun benches: 200 files (~10k LOC) + 10 ADRs, 100 single-file edits through the real watcher.
func runBench() {
	root := filepath.Join(os.TempDir(), fmt.Sprintf("kg5-bench-%d", os.Getpid()))
	os.RemoveAll(root)
	os.MkdirAll(filepath.Join(root, "src"), 0o755)
	os.MkdirAll(filepath.Join(root, "docs"), 0o755)
	for f := 0; f < 200; f++ {
		os.WriteFile(filepath.Join(root, fmt.Sprintf("src/m%d.ts", f)), []byte(body(f, 0)), 0o644)
	}
	for d := 1; d <= 10; d++ {
		os.WriteFile(filepath.Join(root, fmt.Sprintf("docs/ADR-%03d-x.md", d)), []byte(fmt.Sprintf("---\nid: ADR-%03d\n---\n# ADR %d\n", d, d)), 0o644)
	}
	defer os.RemoveAll(root)
	rssBefore := procKB("VmRSS:") / 1024
	db, err := openDB(filepath.Join(root, ".knotgraph", "graph.db"))
	check(err)
	ix := newIndexer(db, root)
	cold, err := ix.indexAll()
	check(err)

	events := make(chan Event, 256)
	ready := make(chan struct{}, 1)
	stop := make(chan struct{})
	go runWatcher(ix, func(e Event) { events <- e }, ready, stop)
	<-ready

	var apply, e2e []float64
	for i := 1; i <= 100; i++ {
		rel := fmt.Sprintf("src/m%d.ts", i%200)
		t0 := time.Now()
		os.WriteFile(filepath.Join(root, rel), []byte(body(i%200, i)), 0o644)
		for {
			select {
			case ev := <-events:
				if ev.Path == rel && ev.Applied {
					e2e = append(e2e, float64(time.Since(t0).Microseconds())/1000)
					apply = append(apply, ev.Ms)
				} else {
					continue
				}
			case <-time.After(5 * time.Second):
				panic("no event")
			}
			break
		}
	}
	time.Sleep(300 * time.Millisecond)
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	rss, hwm := procKB("VmRSS:")/1024, procKB("VmHWM:")/1024
	c0, t0 := cpuTicks(), time.Now()
	time.Sleep(5 * time.Second)
	cpu := float64(cpuTicks()-c0) / 100 / time.Since(t0).Seconds() * 100

	row := func(n, v, t string, ok bool) {
		r := "FAIL"
		if ok {
			r = "PASS"
		}
		fmt.Printf("%-34s %10s   (target %s)  %s\n", n, v, t, r)
	}
	fmt.Printf("files=%d cold=%.0fms (baseline RSS before indexer %.1fMB)\n", cold.Files, cold.Ms, rssBefore)
	a50, a95 := pct(apply, 0.5), pct(apply, 0.95)
	row("reindex txn p50", fmt.Sprintf("%.2fms", a50), "<50ms", a50 < 50)
	row("reindex txn p95", fmt.Sprintf("%.2fms", a95), "<50ms", a95 < 50)
	fmt.Printf("%-34s %.1f / %.1f ms\n", "event e2e p50/p95", pct(e2e, 0.5), pct(e2e, 0.95))
	row("RSS (steady)", fmt.Sprintf("%.1fMB", rss), "<100MB", rss < 100)
	fmt.Printf("%-34s %.1fMB peak, Go heap in use %.1fMB, sys %.1fMB, GC cycles %d\n", "VmHWM", hwm, float64(ms.HeapInuse)/1048576, float64(ms.Sys)/1048576, ms.NumGC)
	row("idle CPU (5s)", fmt.Sprintf("%.2f%%", cpu), "~0%", cpu < 1)
	close(stop)
}
