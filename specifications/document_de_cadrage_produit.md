# Document de Cadrage Produit & Spécifications Générales

**Nom de code projet :** Unified Software Truth Graph (USTG)  
**Version :** 1.1.0  
**Statut :** En validation, 6 PoC réalisés (résultats en section 8)  
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
  │  │  Bun / Tree-sitter    ├──────►│  (SQLite + Extensions)│  │
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
| **Core Indexer** | TypeScript (Bun) + `web-tree-sitter` (WASM) | Parsing du code (AST), extraction des symboles et dépendances localement. Empreinte cible $< 100\text{MB}$ (voir 5.4). |
| **Doc & Git Parser** | TypeScript (Bun) | Ingestion des Markdown/ADRs, extraction des métadonnées, parsing des commits et diffs. |
| **Graph Database** | SQLite (embarqué) + `sqlite-vec` / FalkorDB (serveur) | Stockage relationnel et vectoriel unifié des nœuds, arcs et embeddings de contexte. |
| **Protocol Layer** | Serveur MCP (TypeScript SDK) | Exposition des outils avancés aux agents IA (Claude Code, Cursor, etc.). |
| **Console Web** | Vue 3 + Vite + Cytoscape.js | Interface visuelle d'exploration du graphe, métriques de couverture et traçabilité pour les humains. |

---

## 4. Fonctionnalités Clés & Cas d'Usage Produit

### 4.1 Interface MCP pour Agents IA
Exposition d'outils haut niveau spécifiquement conçus pour limiter la fenêtre de contexte consommée par les LLM.

*État (nov. 2026) :* `get_enriched_blast_radius` est réalisé (PoC 06, sur graphe extrait du code réel) ; `get_node_provenance` est réalisé dans le PoC 01 mais pas encore porté dans le serveur du PoC 06 ; `check_pr_compliance` n'est pas commencé.

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
* **Résultat PoC 02 / 06 :** la réindexation d'un fichier modifié prend quelques millisecondes (p95 $\approx 2\text{ms}$), très en dessous de la cible, avec une transaction SQLite unique et une résolution des arcs limitée au fichier touché.

### 5.2 Résolution d'Entités (Bruit vs Précision)
* **Risque :** Création de liens erronés entre une spec produit et du code sans rapport.
* **Mitigation :**
  * Priorisation des liens déterministes (tags d'ADR dans les commits, annotations d'architecture, IDs de tickets).
  * Application d'un seuil de confiance minimal pour les liens sémantiques issus du NLP.
* **Résultat PoC 06 :** sur le dépôt réel, la résolution des symboles par nom seul rendait **67 %** des arcs ambigus (669 sur 994), car des fonctions homonymes existent dans plusieurs fichiers. Une résolution classée (même fichier, puis module importé, puis tout nœud de ce nom) ramène ce taux à **5,5 %** (32 arcs sur 585) et supprime environ 400 faux liens. Chaque lien porte une confiance `strict` ou `inferred` (score $1/n$). Restent ambigus : imports d'espace de noms, ré-exports par fichiers barrel, alias de chemin non relatifs.

### 5.3 Confidentialité & Sécurité
* **Risque :** Exfiltration de code source ou de documents d'entreprise sensibles.
* **Mitigation :** Architecture *Local-First* par défaut. Le code et le graphe d'AST restent sur le poste du développeur. Seules les métadonnées de synchronisation sont partagées via le serveur d'équipe sécurisé.

### 5.4 Empreinte Ressources de l'Indexeur Local
* **Risque :** Un démon d'indexation résident gêne le poste du développeur s'il consomme trop de mémoire ou de CPU.
* **Décision :** Stack TypeScript / Bun conservée, cible de **RSS $< 100\text{MB}$** en régime établi (cible initiale de $50\text{MB}$ abandonnée). Mesures PoC 02 : ~$81\text{MB}$ sur un dépôt de 210 fichiers (~$67\text{MB}$ sur un petit dépôt), pic transitoire ~$165\text{MB}$ pendant l'indexation initiale, CPU au repos $< 1\%$.
* **Plan B documenté :** un indexeur natif Rust (PoC 04) tient en ~$7\text{MB}$ avec la même latence. Il n'est à engager que si la cible de mémoire se durcit ou si le pic d'indexation initiale pose problème (coût : second langage et binaire par plateforme). Les deux piles partageraient le même schéma SQLite.

### 5.5 Valeur d'Usage Non Démontrée
* **Risque :** Le produit n'a de valeur que si les agents appellent spontanément la provenance et le rayon d'impact, et s'en servent pour de meilleures décisions.
* **État :** Un seul essai, avec une consigne qui disait à l'agent d'utiliser l'outil. L'agent a appelé les deux outils et a demandé la règle manquante au lieu de l'inventer, mais cela ne prouve pas un usage spontané.
* **Mitigation :** Protocole d'évaluation avant tout nouveau chantier fonctionnel : scénario de refonte sur un dépôt réel, au moins 10 exécutions avec et sans l'outil MCP, sans consigne d'utilisation, en comptant les appels à l'outil, les règles métier inventées et les tests oubliés.

### 5.6 Couches Intention sans Données Réelles
* **Risque :** Les liens vers les ADR, règles et tickets sont validés sur une fixture dont j'ai défini les conventions (frontmatter `rules:` / `tickets:`, annotation `// @ticket`). Le dépôt analysé n'a aucun ADR, et aucun tracker (Linear, Jira) n'est lu : le statut des tickets est inconnu.
* **Mitigation :** Valider les conventions sur un vrai projet qui possède des ADR avant d'investir dans les connecteurs de trackers ; afficher explicitement « statut inconnu » tant que la synchronisation n'existe pas (déjà le cas).

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
   * Indexeur Bun / `web-tree-sitter` pour les langages prioritaires (TypeScript, Python, Go). *Validé par les PoC pour TypeScript / JavaScript uniquement ; Python et Go non commencés.*
   * Implémentation du serveur MCP local (SQLite). *Validé (PoC 01, 03, 06).*
   * Outils de navigation de code de base et blast radius structurel. *Validé, avec score de risque et confiance par lien (PoC 06).*
   * *Préalable ajouté :* évaluation de la valeur d'usage auprès des agents (voir 5.5).

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
* **Empreinte de l'indexeur local :** RSS $< 100\text{MB}$ en régime établi, CPU $\approx 0\%$ au repos.
* **Adoption Développeur :** Réduction mesurée du temps d'analyse d'impact lors des revues de code et des refactorings complexes.

---

## 8. Résultats des PoC & Décisions (novembre 2026)

Six PoC ont été réalisés et fusionnés dans `pocs/`. Le détail des mesures, des limites et de la préconisation est dans [`pocs/resultats.md`](../pocs/resultats.md).

### 8.1 Cibles et résultats

| Critère | Cible | Mesuré | Verdict |
|---|---|---|---|
| Indexation initiale (dépôt de test, ~10k lignes) | $< 3\text{s}$ | $\approx 0{,}3\text{s}$ | Atteint |
| Réindexation d'un fichier modifié | $< 50\text{ms}$ | p95 $\approx 2\text{ms}$ | Atteint |
| Requête MCP / analyse d'impact | $< 50\text{ms}$ ; $< 15\text{ms}$ à 3 sauts | p95 $\approx 1$ à $5\text{ms}$ ; cas pire (symbole à 6025 appelants) $86\text{ms}$ | Atteint, sauf le cas pire |
| Préservation des sections manuelles de `CLAUDE.md` | $100\%$ | $100\%$ | Atteint |
| Empreinte mémoire de l'indexeur (régime établi) | $< 100\text{MB}$ | $\approx 81\text{MB}$ (pic initial $\approx 165\text{MB}$) | Atteint, pic hors critère |
| Exhaustivité de l'impact (tests, ADR) | $100\%$ | $100\%$ sur la fixture | Atteint, sur fixture |
| Usage de la provenance par l'agent | systématique | 1 essai, consigne explicite | **Non démontré** |
| Hallucinations d'agent ($> 95\%$ de réponses étayées) | $> 95\%$ | non mesuré | **Non démontré** |

### 8.2 Décisions

1. **Pile conservée :** TypeScript / Bun, SQLite embarqué, `web-tree-sitter`. Un indexeur natif tient en $\approx 7\text{MB}$ (Rust) ou $\approx 15\text{MB}$ (Go) avec la même latence ; ils restent des plans B documentés, à engager seulement si la mémoire devient une contrainte produit (voir 5.4).
2. **Base du produit :** le PoC 06 (indexeur incrémental + moteur d'impact + serveur MCP). Le constructeur de blocs `CLAUDE.md` du PoC 02 doit y être réintégré.
3. **Qualité de résolution avant performance :** le levier principal de l'utilité du rayon d'impact est la précision des liens (67 % d'arcs ambigus avant, 5,5 % après), pas la vitesse.
4. **Pas de nouveau chantier fonctionnel avant d'avoir mesuré la valeur d'usage** (5.5) : synchronisation d'équipe, console web et multi-langages reposent sur cette hypothèse.

### 8.3 Prochaines étapes

1. Évaluer la valeur d'usage (protocole en 5.5).
2. Valider les couches ADR, règles et tickets sur un projet réel qui a des ADR (5.6).
3. Réduire les liens ambigus restants (barrels, alias `tsconfig`, espaces de noms) ; évaluer l'API du compilateur TypeScript si le taux reste élevé sur de plus gros dépôts.
4. Réduire le pic mémoire au démarrage ($\approx 165\text{MB}$) : indexation par lots, chargement à la demande.
5. Plafonner les cas pires du moteur (nombre d'appelants retournés) et calibrer le score de risque sur l'historique git.
