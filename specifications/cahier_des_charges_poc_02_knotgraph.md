# Mini-Cahier des Charges - PoC 02 : Reactive Indexer & CLAUDE.md Builder

**Nom du PoC :** `poc-02-reactive-indexer`  
**Emplacement :** `./pocs/poc-02-reactive-indexer/`  
**Objectif :** Valider l'indexation incrémentale à chaud (temps réel) et la régénération automatique des blocs dynamiques du fichier `CLAUDE.md`.  
**Durée estimée :** 1 à 2 semaines (1 développeur)  
**Version :** 1.0.0 (PoC Scope)

---

## 1. Objectifs & Critères de Succès

### 1.1 Objectifs principaux
1. **Indexation incrémentale ultra-rapide :** Ré-indexer uniquement le fichier modifié (Code TypeScript ou Spec Markdown) sans rebalayer tout le dépôt.
2. **Mise à jour atomique SQLite :** Invalider et remplacer les nœuds et arcs concernés dans la base SQLite locale sans altérer le reste du graphe.
3. **Mise à jour réactive du `CLAUDE.md` :** Régénérer automatiquement les blocs contextuels dynamiques du `CLAUDE.md` tout en préservant le contenu rédigé manuellement par l'équipe.

### 1.2 Critères de succès (KPIs)
* **Latence d'invalidation & réindexation :** $< 50\text{ms}$ par fichier modifié.
* **Intégrité du `CLAUDE.md` :** $100\%$ de préservation des sections hors balises dynamiques (`<!-- KNOTGRAPH:START -->`).
* **Consommation CPU/Mémoire :** Empreinte mémoire (RSS en régime établi, mode `watch` après l'indexation initiale) $< 100\text{MB}$ et CPU $\approx 0\%$ en attente. Le pic transitoire de l'indexation initiale n'est pas contraint par ce critère.
  * *Décision (nov. 2026) :* la cible initiale de $50\text{MB}$ est abandonnée. Le runtime Bun, la pile WASM de tree-sitter et les dépendances occupent déjà ~$33\text{MB}$ (Bun + initialisation WASM) avant tout travail utile, ~$67\text{MB}$ avec le watcher et le rendu Markdown. Mesure du PoC 02 : ~$81\text{MB}$ sur un dépôt de 210 fichiers. Un indexeur natif (Rust) tiendrait en ~$7\text{MB}$ (PoC 04) mais n'est pas retenu à ce stade.

---

## 2. Périmètre Fonctionnel

```
 ┌─────────────────────────────────────────────────────────────┐
 │                    Événement Fichier (FS)                   │
 │           Modifications dans src/ ou docs/ADR/             │
 └──────────────────────────────┬──────────────────────────────┘
                                │ Watcher (chokidar)
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                Parseur Incrémental (AST / MD)               │
 │           Extraction ciblée du delta (Nœuds/Edges)          │
 └──────────────────────────────┬──────────────────────────────┘
                                │ Transactions ciblées
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │               Mise à jour Graphe (SQLite Local)             │
 │          Invalidation + Insertion des nœuds impactés        │
 └──────────────────────────────┬──────────────────────────────┘
                                │ Trigger
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │           Régénérateur AST Markdown (CLAUDE.md)             │
 │          Injecte les blocs dynamiques dans le repo          │
 └─────────────────────────────────────────────────────────────┘
```

### 2.1 Watcher & Pipeline Incrémental
* Écoute en temps réel des répertoires `src/` (code TypeScript) et `docs/` (fichiers `.md` / ADRs).
* Détection du type d'événement : `add`, `change`, `unlink` (suppression).

### 2.2 Stratégie d'Invalidation SQLite
* En cas de modification d'un fichier (`change`) :
  1. Purge des arcs (`edges`) associés aux nœuds déclarés dans ce fichier.
  2. Purge des nœuds (`nodes`) appartenant au fichier.
  3. Re-parsing isolé du fichier via `web-tree-sitter` (code) ou `remark` (markdown).
  4. Insertion des nouveaux nœuds et rétablissement des arcs dans une transaction SQLite unique.

### 2.3 Générateur Dynamique `CLAUDE.md`
* Parse le fichier `CLAUDE.md` à la racine via AST Markdown (`remark`).
* Repère les balises de commentaires HTML :
  * `<!-- KNOTGRAPH:ARCHITECTURE:START -->` ... `<!-- KNOTGRAPH:ARCHITECTURE:END -->`
  * `<!-- KNOTGRAPH:MAP:START -->` ... `<!-- KNOTGRAPH:MAP:END -->`
* Remplace le contenu entre ces balises avec les métadonnées fraîches extraites de SQLite, sans toucher aux autres sections.

---

## 3. Stack Technique (PoC 02)

* **Runtime :** Bun
* **Watcher FS :** `chokidar`
* **Parsing AST Code :** `web-tree-sitter` (version épinglée `0.25.10`, compatible avec les grammaires `tree-sitter-wasms`)
* **Parsing & Transformation Markdown :** `remark`, `remark-gfm`, `unist-util-visit`
* **Base de Données :** `bun:sqlite` (SQLite embarqué de Bun, API synchrone)

---

## 4. Structuration du dossier PoC

```text
./pocs/poc-02-reactive-indexer/
├── src/
│   ├── index.ts               # Point d'entrée & démarrage du Watcher
│   ├── watcher/               # Listener FS (chokidar)
│   ├── graph/                 # Transactions SQLite (purge & upsert)
│   ├── parsers/               # Mini-parsers incrémentaux (TS et Markdown)
│   └── builder/               # Injecteur AST pour CLAUDE.md
├── package.json
├── tsconfig.json
└── README.md
```

---

## 5. Planning & Livrables PoC 02

| Jour(s) | Tâche | Livrable |
| --- | --- | --- |
| **J1 - J2** | Configuration du Watcher `chokidar` & Transactions de purge SQLite | Module `watcher` & `graph-invalidation` |
| **J3 - J4** | Parser incrémental & mise à jour ciblée des nœuds | Pipeline d'indexation à chaud |
| **J5 - J6** | Moteur de rendu AST `CLAUDE.md` (Remark) | Injecteur dynamique dans balises |
| **J7** | Tests de performance (mesure de latence lors de modifications rapides) | Benchmark & Rapport de validation |