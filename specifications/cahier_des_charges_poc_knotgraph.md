# Cahier des Charges - Proof of Concept (PoC)

**Nom du Projet :** Poc_KnotGraph (PoC)  
**Objectif :** Valider la pertinence et la faisabilité d'un graphe unifié (AST + Specs Markdown) exposé via un serveur MCP local réactif.  
**Durée estimée :** 2 à 3 semaines (1 développeur)  
**Version :** 1.0.0 (PoC Scope)

---

## 1. Objectifs du PoC & Critères de Succès

### 1.1 Objectifs principaux
1. **Démontrer la valeur d'usage :** Prouver qu'un agent IA (Claude Code / Cursor) prend de meilleures décisions d'architecture et de refactoring quand il accède à des outils MCP orientés *provenance* et *contexte unifié*.
2. **Valider la vélocité locale :** Garantir que le parsing AST et la mise à jour du graphe local s'exécutent en $< 500\text{ms}$ lors d'une modification de fichier.
3. **Tester la résolution d'entités simple :** Relier automatiquement un symbole de code (ex: fonction) à sa spécification/ADR via des identifiants et des annotations explicites.

### 1.2 Critères de succès (KPIs de validation)
* **Temps d'initialisation (Cold Start) :** Indexation complète d'un dépôt de test de $10\text{k}$ lignes de code + 10 documents Markdown en $< 3\text{ secondes}$.
* **Latence de réponse MCP :** Réponses aux requêtes des outils MCP en $< 50\text{ms}$.
* **Taux d'utilisation de la provenance :** L'agent IA utilise systématiquement `get_node_provenance` pour justifier ses modifications lors des scénarios de test.

---

## 2. Périmètre Fonctionnel (Strictement limité au PoC)

```
       ┌────────────────────────────────────────────────────────┐
       │                   Sources Ingestion                    │
       │    [ Code TS/JS ]             [ Specs / ADR (.md) ]    │
       └───────────┬───────────────────────────┬────────────────┘
                   │                           │
                   ▼                           ▼
       ┌────────────────────────────────────────────────────────┐
       │            Graphe SQLite (.knotgraph/db.sqlite)        │
       │           (Nœuds Code, Nœuds Docs, Arcs Typés)         │
       └───────────────────────────┬────────────────────────────┘
                                   │
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │                 Serveur MCP TypeScript                 │
       │    - get_node_provenance()                             │
       │    - get_enriched_blast_radius()                       │
       └───────────────────────────┬────────────────────────────┘
                                   │
                                   ▼
                    [ Claude Code / Cursor Agent ]
```

### 2.1 Ingestion & Parsing
* **Code :** Prise en charge d'un seul langage cible pour le PoC : **TypeScript / JavaScript**.
  * Extraction des symboles : Fonctions, Classes, Exportations, Imports, Fichiers de test.
* **Documentation :** Ingestion des fichiers Markdown (`.md`) d'un dossier `/docs` ou `/ADR`.
  * Extraction des headers YAML (frontmatter) et des titres (`#`, `##`).
  * Détection des liaisons explicites (ex: tag `implements: ADR-004` dans le frontmatter ou commentaire dans le code `// @ref ADR-004`).

### 2.2 Stockage Graphe Local
* Fichier unique SQLite embarqué (`.knotgraph/graph.db`).
* Schéma minimaliste :
  * Table `nodes` : `id`, `type` (`function`, `file`, `adr`, `test`), `name`, `path`, `content_hash`.
  * Table `edges` : `source_id`, `target_id`, `relation_type` (`CALLS`, `IMPLEMENTS`, `TESTS`, `CONTAINS`).

### 2.3 Serveur MCP (Protocol Layer)
Implémentation de **2 outils MCP clefs** via Stdio (standard d'échange CLI) :

1. **`get_node_provenance(symbol_name: string)`**
   * *Entrée :* Nom d'une fonction ou classe.
   * *Sortie :* Chaîne complète de provenance en JSON structuré :  
     `Fonction → Fichier Source → ADR/Spec lié → Suite de Test correspondante`.

2. **`get_enriched_blast_radius(symbol_name: string)`**
   * *Entrée :* Nom d'un symbole à modifier/supprimer.
   * *Sortie :* Liste des appelants directes (code), liste des tests unitaires à re-exécuter, et liste des specs/décisions impactées.

---

## 3. Stack Technique retenue pour le PoC

Pour garantir la vélocité d'écriture du prototype (livrable rapidement) :

* **Runtime :** Bun
* **Langage :** TypeScript
* **Parsing Code :** `web-tree-sitter` (Tree-sitter compilé en WASM pour JS/TS, version épinglée `0.25.10`)
* **Parsing Markdown :** `remark` / `gray-matter`
* **Base de Données :** `bun:sqlite` (SQLite embarqué de Bun, synchrone et rapide)
* **SDK MCP :** `@modelcontextprotocol/sdk` (SDK officiel TypeScript)

---

## 4. Scénario de Test & Démonstration (Le "Test Crash")

Pour valider le PoC, nous utiliserons un projet modèle (Dummy Project) contenant :
* 5 modules TypeScript (ex: calcul de taxes, gestion de panier).
* 2 documents ADR (`ADR-001-tax-rules.md`, `ADR-002-cart-storage.md`).
* 3 suites de tests Jest/Vitest.

**Scénario de test avec Claude Code :**
1. **Consigne donnée à l'agent :** *"Nous devons modifier la logique du calcul de la TVA pour supporter la règle européenne 2026. Utilise KnotGraph pour vérifier ce que cette règle impacte et quelle spec la définit avant d'écrire du code."*
2. **Attendu de la démo :**
   * L'agent appelle `get_node_provenance("calculateVAT")`.
   * L'agent identifie l'ADR lié (`ADR-001`), lit la spec exacte, identifie les 3 tests à mettre à jour et réalise la modification sans halluciner sur la règle métier.

---

## 5. Hors Périmètre (Exclu du PoC)

Les éléments suivants sont **exclus** de cette phase et seront traités en phase produit :

* ❌ Support multi-langages (Python, Go, Java, Rust...).
* ❌ Connexion aux APIs tierces (Linear, Jira, GitHub PRs, Slack).
* ❌ Interface Graphique Web (Visualizer Vue 3 / Cytoscape).
* ❌ Synchronisation Cloud / Multi-développeurs.
* ❌ Ingestion de fichiers non-structurés (PDF, vidéos).

---

## 6. Planning & Livrables PoC

| Jour(s) | Tâche / Étape | Livrable |
| --- | --- | --- |
| **J1 - J3** | Setup projet, Schéma SQLite, Parser Tree-sitter TS | Module `knotgraph-parser` |
| **J4 - J6** | Parser Markdown (ADR) + Résolution d'entités simple | Moteur d'indexation unifié |
| **J7 - J9** | Serveur MCP (Stdio) + Implémentation des 2 outils | Serveur MCP fonctionnel |
| **J10 - J12** | Tests d'intégration avec Claude Code sur le projet démo | Benchmark & Rapport de validation |