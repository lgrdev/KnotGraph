# Document de Cadrage Produit & Spécifications Générales

**Nom de code projet :** Unified Software Truth Graph (USTG)  
**Version :** 1.0.0  
**Statut :** En validation  
**Date :** Novembre 2026  

---

## 1. Vision Produit & Positionnement

### 1.1 Constat & Problématique
Dans l'ingénierie logicielle augmentée par l'IA, les serveurs de contexte actuels (MCP, indexeurs vectoriels) souffrent d'une découpe binaire :
* **Les index structurels (AST, Code Graph) :** Répondent à *« Comment le code est structuré et ce qu'une modification casse »*, mais ignorent l'intention métier.
* **Les mémoires de contexte (RAG documentaire, Vector stores) :** Répondent à *« Pourquoi ce code existe »*, mais s'appuient sur des recherches probabilistes sans garantie de traçabilité déterministe.

Cette séparation crée des pertes de contexte, des dérives d'architecture et des hallucinations lors des sessions de développement assisté par agent (Claude Code, Cursor, Codex, etc.).

### 1.2 Proposition de Valeur
**« Le graphe de vérité du cycle de vie logiciel »**  
Un produit unifié qui construit un **graphe de connaissances déterministe et orienté provenance**, reliant en temps réel :
$$\text{Intention (ADR, Specs)} \longleftrightarrow \text{Implémentation (AST, Code)} \longleftrightarrow \text{Livraison (Git, PR, CI)} \longleftrightarrow \text{Vérification (Tests, Incidents)}$$

Le différenciateur principal n'est pas le stockage conjoint du code et des documents, mais la **traçabilité stricte (provenance)** : chaque affirmation transmise à un agent ou affichée à un humain est adossée à une preuve vérifiable (fichier, ligne, décision, commit, ticket).

---

## 2. Péri mètre & Modèle de Données Unifié

Le produit s'articule autour d'un modèle de graphe unifié composé de 4 couches d'entités connectées par des relations typées.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Couche Intention & Métier                    │
│      (Specs, ADR, Exigences, Tickets Jira/Linear, Incidents)     │
└────────────────────────────────┬────────────────────────────────┘
                                 │ implémente / valide
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Couche Code & Structure                     │
│        (AST, Fonctions, Classes, Routes API, Schémas DB)        │
└────────────────────────────────┬────────────────────────────────┘
                                 │ couvert par / testé par
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Couche Livraison & Qualité                   │
│         (Commits, PRs, Couverture de Test, Builds CI)           │
└────────────────────────────────┬────────────────────────────────┘
                                 │ traçabilité / contexte
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Couche Mémoire d'Équipe                     │
│    (Décisions d'Architecture, Invariants, Règles Métier)       │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 Entités Principales (Nœuds)
* **CodeNodes :** Symbole, Fonction, Classe, Route API, Table/Schéma DB, Fichier de Test.
* **DocNodes :** Section de Spec, Décision (ADR), Ticket Métier (Jira/Linear), Incident.
* **DeliveryNodes :** Commit, Pull Request, Release, Résultat CI.
* **RuleNodes :** Convention d'architecture, Invariant métier, Règle de sécurité.

### 2.2 Relations Majeures (Arcs)
* `IMPLEMENTS` : `CodeNode` $\rightarrow$ `DocNode` (Une fonction implémente un ADR/Ticket).
* `TESTS` : `CodeNode (Test)` $\rightarrow$ `CodeNode (Source)` (Un test couvre une fonction).
* `TOUCHES` : `DeliveryNode (PR/Commit)` $\rightarrow$ `CodeNode` / `DocNode`.
* `CONSTRAINS` : `RuleNode` $\rightarrow$ `CodeNode` / `DocNode`.

---

## 3. Architecture Technique Cible

Le produit s'appuie sur une architecture hybride **Local-First pour la vélocité et la confidentialité**, avec un **serveur de synchronisation centralisé pour le contexte d'équipe**.

```
  ┌─────────────────────────────────────────────────────────────┐
  │                   Poste Développeur / CI                    │
  │                                                             │
  │  ┌───────────────────────┐       ┌───────────────────────┐  │
  │  │  Moteur d'Indexation  │       │ Stockage Graphe Local │  │
  │  │   Rust / Tree-sitter  ├──────►│  (SQLite + Extensions)│  │
  │  └───────────────────────┘       └───────────┬───────────┘  │
  │                                              │              │
  │                                              ▼              │
  │                                  ┌───────────────────────┐  │
  │                                  │   Serveur MCP Native  │  │
  │                                  └───────────┬───────────┘  │
  └──────────────────────────────────────────────┼──────────────┘
                                                 │ SSE / WebSockets
                                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                    Plateforme d'Équipe                      │
  │  ┌────────────────────────┐       ┌──────────────────────┐  │
  │  │ Synchronisation Graphe │       │ Console Web Humaine  │  │
  │  │  (Webhooks / Workers)  │       │ (Vue 3 / Visualizer) │  │
  │  └────────────────────────┘       └──────────────────────┘  │
  └─────────────────────────────────────────────────────────────┘
```

### 3.1 Composants Techniques

| Composant | Technologie retenue | Rôle principal |
|---|---|---|
| **Core Indexer** | Rust + Tree-sitter | Parsing ultra-rapide du code (AST), extraction des symboles et dépendances localement. |
| **Doc & Git Parser** | Go / TypeScript (Bun) | Ingestion des Markdown/ADRs, extraction des métadonnées, parsing des commits et diffs. |
| **Graph Database** | SQLite (embarqué) + `sqlite-vec` / FalkorDB (serveur) | Stockage relationnel et vectoriel unifié des nœuds, arcs et embeddings de contexte. |
| **Protocol Layer** | Serveur MCP (TypeScript SDK) | Exposition des outils avancés aux agents IA (Claude Code, Cursor, etc.). |
| **Console Web** | Vue 3 + Vite + Cytoscape.js | Interface visuelle d'exploration du graphe, métriques de couverture et traçabilité pour les humains. |

---

## 4. Fonctionnalités Clés & Cas d'Usage Produit

### 4.1 Interface MCP pour Agents IA
Exposition d'outils haut niveau spécifiquement conçus pour limiter la fenêtre de contexte consommée par les LLM :

* **`get_node_provenance(node_id)` :**
  Renvoie l'arborescence complète justifiant l'existence d'un bloc de code.
  *Exemple :* `Function calculateVAT()` $\rightarrow$ `ADR-004` $\rightarrow$ `Ticket ENG-102` $\rightarrow$ `Suite de tests unitaires`.
* **`get_enriched_blast_radius(target_symbol)` :**
  Calcul du rayon d'impact avant modification.
  *Retour :* Nombre d'appelants directs, tests impactés, documents de spécification concernés et tickets ouverts en lien.
* **`check_pr_compliance(diff_id)` :**
  Détection automatique des écarts entre la PR et le graphe (ex: modification d'une règle métier sans mise à jour du test ou de l'ADR lié).

### 4.2 Métadonnées de Confiance & Traçabilité
Chaque réponse transmise à l'agent contient un bloc de métadonnées obligatoires :
$$\text{Metadata} = \{ \text{Source}, \text{CommitHash}, \text{Timestamp}, \text{ConfidenceScore}, \text{TraceabilityChain} \}$$

---

## 5. Gestion des Risques Techniques

### 5.1 Fraîcheur du Graphe & Invalidation
* **Risque :** Obsolescence des liens lors des modifications rapides de code ou de specs.
* **Mitigation :**
  * Indexation incrémentale sur évènement Git (Git hooks locaux et webhooks GitHub/GitLab).
  * Séparation de l'indexation AST (synchrone, $< 100\text{ms}$) et de l'analyse documentaire NLP (asynchrone, en arrière-plan).

### 5.2 Résolution d'Entités (Bruit vs Précision)
* **Risque :** Création de liens erronés entre une spec produit et du code sans rapport.
* **Mitigation :**
  * Priorisation des liens déterministes (tags d'ADR dans les commits, annotations d'architecture, IDs de tickets).
  * Application d'un seuil de confiance minimal pour les liens sémantiques issus du NLP.

### 5.3 Confidentialité & Sécurité
* **Risque :** Exfiltration de code source ou de documents d'entreprise sensibles.
* **Mitigation :** Architecture *Local-First* par défaut. Le code et le graphe d'AST restent sur le poste du développeur. Seules les métadonnées de synchronisation sont partagées via le serveur d'équipe sécurisé.

---

## 6. Plan de Déploiement & Feuille de Route (Roadmap)

```
        Q1 2027                    Q2 2027                    Q3 2027
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│  Phase 1 : Core Code │   │ Phase 2 : Integration│   │ Phase 3 : Team Sync  │
│    & Local MCP       │──►│   Docs & Provenance  │──►│   & Cloud Service    │
└──────────────────────┘   └──────────────────────┘   └──────────────────────┘
```

1. **Phase 1 — Moteur d'AST & Serveur MCP Local (T1 2027)**
   * Indexeur Rust / Tree-sitter pour les langages prioritaires (TypeScript, Python, Go).
   * Implémentation du serveur MCP local (SQLite).
   * Outils de navigation de code de base et blast radius structurel.

2. **Phase 2 — Ingestion Documentaire & Traçabilité (T2 2027)**
   * Ingestion des specs Markdown, ADR, tickets Linear/Jira et PRs Git.
   * Algorithme de liaison déterministe et sémantique (résolution d'entités).
   * Intégration des contrats de provenance dans les réponses MCP.

3. **Phase 3 — Synchronisation d'Équipe & Console Web (T3 2027)**
   * Backend centralisé pour la synchronisation du graphe d'équipe.
   * Dashboard Web interactif d'exploration et de garde-fou de PR.
   * Déploiement pour les entreprises (SSO, RBAC, mode On-Premise).

---

## 7. Critères de Succès & Métriques Produit (KPIs)

* **Réduction du taux d'hallucination d'agent :** Retours d'agents IA mesurés avec $> 95\%$ de réponses étayées par une source exacte.
* **Temps de mise à jour de l'index :** Invalidation et réindexation du code AST $< 200\text{ms}$ par commit local.
* **Adoption Développeur :** Réduction mesurée du temps d'analyse d'impact lors des revues de code et des refactorings complexes.