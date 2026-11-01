# Résultats des PoC KnotGraph

Mesures faites sur une seule machine Linux, un seul développeur, sans répétition statistique (sauf mention). Les cibles sont celles des cahiers des charges de `specifications/`, mises à jour le 2026-11 (mémoire de l'indexeur : < 100 Mo, runtime Bun conservé).

## 1. Vue d'ensemble

| PoC | Objectif | Stack | Tests | Verdict |
|---|---|---|---|---|
| **01** `poc-01-knotgraph` | Graphe unifié (AST + ADR) en SQLite exposé par un serveur MCP, outils `get_node_provenance` et `get_enriched_blast_radius` | Bun, web-tree-sitter, `bun:sqlite`, SDK MCP | 8 | Retenu. Cibles de latence tenues, usage par l'agent non démontré (1 essai) |
| **02** `poc-02-reactive-indexer` | Réindexation à chaud d'un seul fichier et régénération des blocs dynamiques de `CLAUDE.md` | Bun, chokidar, remark | 11 | Retenu. Cibles tenues avec la cible mémoire relevée à 100 Mo, sauf le pic au démarrage |
| **03** `poc-03-blast-radius` | Moteur d'impact multi-couches (code, tests, ADR, règles, tickets) avec score de risque | Bun, CTE récursives, SDK MCP | 19 | Algorithme validé sur **données synthétiques** ; cas pire hors cible |
| **04** `poc-04-rust-indexer` | Chemin chaud de l'indexeur en Rust, pour la cible mémoire de 50 Mo | Rust, tree-sitter natif, rusqlite, notify | 9 | Plan B documenté |
| **05** `poc-05-go-indexer` | Même chemin chaud en Go, pour mesurer le coût réel de Go | Go, go-tree-sitter, go-sqlite3, fsnotify | 9 | Plan B documenté |
| **06** `poc-06-real-graph` | Moteur du PoC 03 sur un graphe extrait du vrai code | Bun (PoC 02 + 03 combinés) | 22 | Retenu comme base. Couches code et tests validées sur données réelles, couches spec/règles/tickets sur fixture seulement |

## 2. Critères de succès, PoC par PoC

| Critère (cible) | PoC 01 | PoC 02 | PoC 03 | PoC 04 (Rust) | PoC 05 (Go) | PoC 06 |
|---|---|---|---|---|---|---|
| Cold start, 210 fichiers (~10k lignes) (< 3 s) | 280 ms | ~300 ms | n/a | ~86 ms | ~290 ms | 94 fichiers en ~260 ms |
| Réindexation d'un fichier (< 50 ms ; < 500 ms au PoC 01) | 4 ms | p95 2,0 ms | n/a | p95 1,9 ms | p95 2,9 ms | 2,7 ms (test live) |
| Événement → base, p95 | n/a | 3,8 ms | n/a | 7,3 ms (dont 5 ms de regroupement voulu) | 8,3 ms (idem) | n/a |
| Requête MCP / analyse (< 50 ms ; < 15 ms à 3 sauts au PoC 03) | p95 2 ms | n/a | p95 5,0 ms sur 38,9k arcs ; **cas pire 86 ms** | n/a | n/a | 123 symboles : p95 1,0 ms, max 2,4 ms |
| RSS en régime établi, 210 fichiers (< 100 Mo) | non mesuré | **~81 Mo** (67 Mo sur 4 fichiers) | non mesuré | **~7 Mo** | **~15 Mo** | non mesuré |
| RSS pic pendant l'indexation initiale | non mesuré | **~165 Mo** | non mesuré | ~6,4 Mo | ~14 Mo | non mesuré |
| CPU au repos (~0 %) | n/a | ~0,4 % | n/a | 0,00 % | 0,00 % | n/a |
| Sections manuelles de `CLAUDE.md` préservées (100 %) | n/a | **100 %** (tests, CRLF et balises en bloc de code compris) | n/a | hors périmètre | hors périmètre | hors périmètre |
| Exhaustivité de l'impact (100 %) | n/a | n/a | 100 % sur le graphe semé | n/a | n/a | 100 % sur la fixture `shop` |
| Liens stricts vs inférés distingués | n/a | n/a | oui (semés à la main) | n/a | n/a | oui (**calculés**) |
| L'agent utilise la provenance | oui, **1 essai**, consigne explicite | n/a | n/a | n/a | n/a | non rejoué |

## 3. Comparaison des trois piles pour l'indexeur (même scénario : 200 fichiers + 10 ADR, 100 modifications)

| | Bun/TS (PoC 02) | Go (PoC 05) | Rust (PoC 04) |
|---|---|---|---|
| RSS établi (210 fichiers) | ~81 Mo | ~15 Mo | ~7 Mo |
| Pic au cold start | ~165 Mo | ~14 Mo | ~6,4 Mo |
| Transaction p95 | 2,0 ms | 2,9 ms | 1,9 ms |
| Cold start | ~300 ms | ~290 ms | ~86 ms |
| Taille du livrable | runtime + dépendances | binaire 9,5 Mo | binaire 4,1 Mo |
| Code du chemin chaud (parsing + graphe + watcher + bench) | ~580 lignes | ~1170 lignes (tests inclus) | ~840 lignes |
| Intégration avec le serveur MCP et le moteur (TypeScript) | même langage | deux langages, un schéma SQLite partagé | idem |

La latence est équivalente partout : c'est SQLite qui domine. L'écart se joue sur la mémoire, surtout au démarrage.

## 4. Résultat du PoC 06 sur le dépôt réel (94 fichiers TypeScript, sans ADR)

| | Résolution par nom seul (PoC 01 à 03) | Résolution classée (PoC 06) |
|---|---|---|
| Arcs | 994 | 585 |
| Arcs inférés | 669 (67 %) | 32 (5,5 %) |
| Fausses pistes dans « tests à relancer » de `computeRisk` | tests du PoC 01 sans rapport | disparues |

Classement des candidats : même fichier, puis module d'import, puis tout nœud de ce nom. Cas non résolus (restent « inférés ») : imports d'espace de noms, ré-exports par fichiers barrel, alias de chemin non relatifs.

## 5. Ce qui est démontré, ce qui ne l'est pas

**Démontré**
- Une approche SQLite locale avec réindexation par fichier tient très largement les cibles de latence (10 à 100 fois sous les seuils).
- L'intégrité de `CLAUDE.md` peut être garantie à 100 % en remplaçant par positions plutôt qu'en réécrivant le Markdown.
- La qualité de la résolution des symboles pèse plus sur l'utilité du rayon d'impact que la performance : 67 % de liens douteux avant, 5,5 % après.
- Un indexeur natif divise la mémoire par 5 (Go) à 12 (Rust) sans changer la latence.

**Non démontré**
- **Valeur d'usage** : « l'agent utilise systématiquement la provenance » repose sur un seul essai, avec une consigne qui le lui disait.
- **Couches spec, règles, tickets sur données réelles** : le dépôt n'a pas d'ADR, de règles ni de tickets. Les conventions (frontmatter `rules:` / `tickets:`, `@ticket`) sont de mon fait et aucun tracker n'est lu (statut des tickets `null`).
- **Poids du score de risque** : mon calibrage (0,86 sur `calculateVAT` contre 0,82 dans l'exemple du cahier des charges), non confronté à de vrais incidents.
- **Passage à l'échelle** : le plus gros dépôt testé fait 94 fichiers réels et 10k nœuds synthétiques ; un symbole appelé par 6025 autres prend 86 ms.
- **Portabilité** : Linux uniquement.

## 6. Préconisation

**Garder Bun/TypeScript + SQLite, et prendre le PoC 06 comme base du produit.** Les cibles sont tenues avec cette pile (81 Mo contre 100 Mo), elle partage un seul langage avec le serveur MCP et le moteur, et elle évite un second toolchain. Rust et Go restent des plans B mesurés, pas des besoins.

**Ordre de travail proposé**

1. **Mesurer la valeur d'usage avant tout le reste.** C'est le critère le moins prouvé et le seul qui justifie le produit. Protocole : le scénario de refonte sur le dépôt réel, N ≥ 10 exécutions, avec et sans l'outil MCP, **sans consigne d'utiliser KnotGraph**, et compter les appels à l'outil, les hallucinations de règle métier et les tests oubliés. Si l'agent ne s'en sert pas spontanément, ajuster les descriptions d'outils avant de construire davantage.
2. **Éprouver les couches spec / règles / tickets sur un vrai projet qui a des ADR.** Valider les conventions de frontmatter avec ses auteurs, puis seulement envisager Linear ou Jira. Tant que le statut des tickets n'est pas synchronisé, le dire dans les réponses (c'est déjà le cas).
3. **Améliorer la résolution là où elle reste inférée** : ré-exports par barrel, alias `tsconfig`, imports d'espace de noms. Si le taux de liens inférés reste significatif sur des dépôts plus gros, évaluer l'API du compilateur TypeScript pour les symboles TS, plus précise que tree-sitter.
4. **Traiter le pic de 165 Mo au démarrage avant de réécrire quoi que ce soit** : indexer par lots, charger remark et les grammaires à la demande. Le critère de 100 Mo porte sur le régime établi, mais un pic de 165 Mo se voit sur le poste du développeur.
5. **Plafonner les cas pires du moteur** : limiter le nombre d'appelants retournés ou agréger au-delà d'un seuil (le hub à 6025 appelants prend 86 ms).
6. **Réintégrer le constructeur de blocs `CLAUDE.md` (PoC 02) dans le PoC 06** pour avoir un seul paquet : indexeur, moteur, MCP et `CLAUDE.md`.
7. **Calibrer le score de risque** sur l'historique git (corrections de bogues après modification de tel symbole), ou le présenter comme une heuristique avec son détail, sans seuil bloquant.

**Quand basculer vers du natif.** Passer à Rust si la mémoire devient une contrainte produit (budget < 50 Mo, ou plusieurs indexeurs résidents sur la même machine). Rust est plus léger que Go sur tous les points mesurés ; Go se justifie seulement si l'équipe préfère sa simplicité de relecture. Dans les deux cas, garder le schéma SQLite actuel (versionné, reconstruit au changement) pour que le serveur MCP et le moteur TypeScript lisent la même base.

**Ce que je ne ferais pas maintenant** : la synchronisation d'équipe, la console web et le support multi-langages. Tant que l'étape 1 n'a pas montré que les agents tirent parti de la provenance et du rayon d'impact, ces chantiers reposent sur une hypothèse non vérifiée.
