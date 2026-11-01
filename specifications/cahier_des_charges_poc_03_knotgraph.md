# Mini-Cahier des Charges - PoC 03 : Enriched Blast Radius Engine

**Nom du PoC :** `poc-03-blast-radius`

**Emplacement :** `./pocs/poc-03-blast-radius/`

**Objectif :** Valider l'algorithme de calcul d'impact enrichi (Blast Radius) capable de traverser simultanément la structure du code, les règles métier (ADR/Specs), les tests unitaires et les tickets concernés.

**Durée estimée :** 1 à 2 semaines (1 développeur)

**Version :** 1.0.0 (PoC Scope)

## 1. Objectifs & Critères de Succès

### 1.1 Objectifs principaux

1. **Traversée multi-couches :** Calculer le rayon d'impact d'un changement de code en ne se limitant pas aux appelants directes (AST), mais en remontant jusqu'aux spécifications métier, aux tests unitaires impactés et aux tickets associés.

2. **Scoring de risque déterministe :** Produire un score de risque global ($0.0 \rightarrow 1.0$) pour un symbole ou un fichier de diff donné, basé sur la profondeur de la dépendance et le statut des documents associés.

3. **Restitution synthétique pour IA & Humains :** Fournir un rapport d'impact structuré et lisible aussi bien par un agent MCP que sous forme de rapport Markdown/Terminal.

### 1.2 Critères de succès (KPIs)

* **Temps de calcul :** Recherche de profondeur 3-hop sur le graphe SQLite en $< 15\text{ms}$.

* **Exhaustivité du Blast Radius :** $100\%$ des tests unitaires dépendants et des ADRs annotés identifiés lors du test de refactoring.

* **Score de confiance :** Distinction explicite entre les liens stricts (AST, tags `@ref`) et les liens probabilistes/sémantiques.

## 2. Périmètre Fonctionnel

```
┌─────────────────────────────────────────────────────────────┐
│                 Target Symbol / File Diff                   │
│           (Ex: modification de `calculateVAT()`)             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              Moteur de Traversée Multi-Hop                  │
│               (SQLite Graph Traversal API)                  │
└──────┬───────────────────────┼───────────────────────┬──────┘
       │                       │                       │
       ▼                       ▼                       ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│  Code Callers│       │ Tests Suites │       │  ADRs / Specs│
│  (AST Depth) │       │ (To Re-run)  │       │ (To Review)  │
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                       │                       │
       └───────────────────────┼───────────────────────┘
                               │ Aggregation & Scoring
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               Enriched Blast Radius Report                  │
│       - Callers Count & List                                │
│       - Impacted Tests Array                                │
│       - Affected Specifications / Business Rules            │
│       - Risk Score & Actionable Recommendations             │
└─────────────────────────────────────────────────────────────┘

```

### 2.1 Algorithme de Traversée (Recursive Graph Queries)

* Requêtes récursives (Common Table Expressions - CTE sous SQLite) pour remonter et descendre le graphe :

  1. **Avis descendant (Code) :** `CodeNode` $\rightarrow$ `CALLS` $\rightarrow$ `CallerNodes` (Profondeur configurable, par défaut $N=3$).

  2. **Avis de vérification (Tests) :** `CodeNode` $\leftarrow$ `TESTS` $\leftarrow$ `TestFileNodes`.

  3. **Avis d'intention (Specs/ADR) :** `CodeNode` $\rightarrow$ `IMPLEMENTS` $\rightarrow$ `DocNodes`.

  4. **Avis de gouvernance (Règles) :** `DocNode` $\rightarrow$ `CONSTRAINS` $\rightarrow$ `RuleNodes`.

### 2.2 Calcul du Score de Risque (Risk Engine)

Calcul d'un score de risque normalisé basé sur la formule :

$$
\text{RiskScore} = \min\left(1.0, \sum (w_{\text{callers}} \cdot N_{\text{callers}} + w_{\text{rules}} \cdot N_{\text{rules}} + w_{\text{untested}} \cdot I_{\text{untested}})\right)
$$

Où :
* $w_{\text{callers}}$ : Poids du nombre d'appelants affectés.
* $w_{\text{rules}}$ : Poids des contraintes d'architecture ou règles métier touchées.
* $w_{\text{untested}}$ : Pénalité si le nœud source n'a pas de couverture de test liée dans le graphe.

### 2.3 Format de Restitution (MCP Tool Payload)

```json
{
  "target": "calculateVAT",
  "riskScore": 0.82,
  "riskLevel": "HIGH",
  "blastRadius": {
    "codeCallers": [
      { "symbol": "checkoutCart", "file": "src/services/cart.ts", "depth": 1 },
      { "symbol": "generateInvoice", "file": "src/services/billing.ts", "depth": 2 }
    ],
    "testsToRun": [
      { "file": "tests/billing.test.ts", "suite": "VAT Calculation Cases" }
    ],
    "impactedSpecs": [
      { "id": "ADR-004", "title": "EU 2026 VAT Compliance", "path": "docs/adr/004-vat.md" }
    ]
  },
  "recommendations": [
    "Run `tests/billing.test.ts` before committing.",
    "Review `ADR-004` to ensure business rule alignment."
  ]
}
```

## 3. Stack Technique (PoC 03)

* **Runtime :** Bun
* **Langage :** TypeScript
* **Moteur de Requêtes Graphe :** `bun:sqlite` (Requêtes récursives `WITH RECURSIVE`)
* **Formatters :** Output JSON pour MCP + CLI Output colorisé (codes ANSI directs, sans dépendance `chalk` / `boxen`)

## 4. Structuration du dossier PoC

```
./pocs/poc-03-blast-radius/
├── src/
│   ├── index.ts               # Runner CLI pour tester l'analyse d'impact
│   ├── graph/                 # Seed DB SQLite avec un graphe de test complexe
│   ├── engine/                # Moteur d'analyse (CTE SQL & calcul de score)
│   └── formatters/            # Formatters MCP et Terminal
├── package.json
├── tsconfig.json
└── README.md
```

## 5. Planning & Livrables PoC 03

| Jour(s) | Tâche | Livrable |
| ----- | ----- | ----- |
| **J1 - J2** | Création du dataset SQLite de test (graphe 3-tier interconnecté) | Script `seed-graph.ts` |
| **J3 - J4** | Écriture des requêtes récursives CTE & Traversal Engine | Module `blast-radius-engine` |
| **J5 - J6** | Implémentation du système de scoring & des recommendations | Module `risk-calculator` |
| **J7** | Tests d'intégration et intégration de l'outil dans le serveur MCP du PoC 01 | Démonstration complète d'analyse d'impact |
