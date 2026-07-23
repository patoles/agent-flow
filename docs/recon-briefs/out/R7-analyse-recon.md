# R7 — Audit de la recon « vue orchestrateur » + plan consolidé

> **Lecture seule.** Aucune écriture hors de ce rapport. `~/.ao/data/ao.db` lu en mode
> `readonly` strict (`node:sqlite`, flag `readOnly:true`) — aucune modification du store live.
> Date : 2026-07-20. Worktree de référence inspecté :
> `C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1`.
> Rapport audité : `docs/RECON-orchestrator-view.md` (produit par la session `agent-flow-2`).

## Méthodo & preuves recueillies

Contrôles rejoués **indépendamment** ce jour depuis le worktree `agent-flow-4` (sous AO) :
- `ao status/session ls/session get/orchestrator ls --json` + `ao --help` (arbre de commandes complet) ;
- lecture `ao.db` read-only (45 sessions, schéma `sessions` complet) ;
- lecture d'un transcript Claude réel (`~/.claude/projects/…agent-flow-1/*.jsonl`) pour la jointure ;
- latence CLI (3 essais) + probes REST `127.0.0.1:3001` ;
- lecture du code Phases 1/2 (`relay.ts`, `use-vscode-bridge.ts`, `use-agent-simulation.ts`,
  `canvas.tsx`, `session-pane.tsx`, `split-view.tsx`, `index.tsx`, `top-bar.tsx`, `session-grouping.ts`,
  `protocol.ts`, `bridge-types.ts`, `constants.ts`).

---

## Partie A — Audit des conclusions (CONFIRMÉ / À CORRIGER / À NUANCER)

| # | Affirmation de la recon | Verdict | Preuve indépendante |
|---|---|---|---|
| A1 | Jointure `normalize(cwd) === normalize(workspace_path)`, validée à l'octet | **CONFIRMÉ** (valeur) | transcript `…agent-flow-1/5f49f459-….jsonl` → `entry.cwd = C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1` ; `ao.db.sessions.workspace_path` (id `agent-flow-1`) = **même chaîne à l'octet**. `sessionId` du transcript = basename `.jsonl` = UUID. |
| A1-bis | « Transport = `ao … --json` fournit l'arbre avec `workspace_path` » | **À CORRIGER (majeur)** | **Ni `ao session ls --json` ni `ao session get <id> --json` ne renvoient `workspace_path`** (ni `branch`, ni `kind`→exposé comme `role`). Champs `ls` : `id, projectId, role, status, harness, isTerminated, lastActivityAt, createdAt, updatedAt`. La clé de jointure **n'est PAS dans le contrat CLI** → voir B1. |
| A2 | `agent_session_id` vide partout (pas de jointure UUID) | **CONFIRMÉ** | `SELECT COUNT(*) … WHERE agent_session_id != ''` → **0** sur 45 sessions (lecture DB ro directe). |
| A3 | Parenté implicite par `project_id` (orch = `kind='orchestrator'`), aucune colonne parent | **CONFIRMÉ** | Colonnes réelles de `sessions` : `id, project_id, num, issue_id, kind, harness, activity_state, activity_last_at, is_terminated, branch, workspace_path, runtime_handle_id, agent_session_id, prompt, created_at, updated_at, display_name, first_signal_at, preview_url, preview_revision`. **Aucun** `parent_id`/`orchestrator_id`/`spawned_by`. |
| A3-bis | « agent-flow et launcher n'ont pas d'orchestrateur » | **À NUANCER** | Faux **maintenant** : `agent-flow-6` (`kind='orchestrator'`, non terminé) existe. Il n'apparaissait PAS dans mon 1er `ao orchestrator ls` puis est apparu 2 min après → **la topologie change en direct**. Conclusion : ne rien coder en dur ; gérer dynamiquement **0..N orchestrateurs par projet** + le fallback « sans orchestrateur ». |
| A4 | Pas d'API REST exploitable (:3001 → 404) | **CONFIRMÉ** | `GET /`, `/health`, `/sessions`, `/api/sessions` → **404** partout. |
| A4-bis | Latence `ao … --json` ~37 ms, polling 2-3 s « aligné sur SCAN_INTERVAL » | **À NUANCER** | Re-mesuré **45/50/45 ms** par appel (même ordre, OK). Mais : (a) il faut **2 appels/cycle** (`orchestrator ls` + `session ls`) ≈ ~100 ms ; (b) `SCAN_INTERVAL_MS = 1000` et `POLL_FALLBACK_MS = 3000` (`extension/src/constants.ts:14,17`) — le « 2-3 s » n'est pas SCAN_INTERVAL. Choisir un intervalle **dédié** (2-3 s reste raisonnable). |
| A5 | Détection « sous AO » = env `AO_*` + `ao.db` + `ao status` | **CONFIRMÉ + À NUANCER** | Mon process agent porte bien `AO_SESSION_ID=agent-flow-4`, `AO_PROJECT_ID`, `AO_DATA_DIR`, `AO_OWNER`. **Mais** `AO_SESSION_ID` a été **absent** ici tant que le sous-agent n'héritait pas — et **le relay tourne dans un autre process** (app AO ou `npx agent-flow-app`) qui n'hérite pas forcément des `AO_*`. La recon a raison : s'appuyer sur `ao status` + présence `ao.db`, pas sur l'env seul. Détail : `runFile` = `C:\Users\nicol\.ao\running.json` (**pas** sous `data/` comme l'écrit la recon). |
| A6 | « Nouveau champ requis : ajouter `cwd` à `SessionInfo` » | **OBSOLÈTE (déjà fait)** | `cwd?: string` est **déjà** dans `SessionInfo` (`extension/src/protocol.ts:40`, `web/lib/bridge-types.ts:24`) et propagé par le relay (`relay.ts:527`, `:108`). Livré en **Phase 1**. Le lot correspondant est donc **quasi terminé**. |

### Angles morts relevés (non traités par la recon)
- **1 session AO ↔ N transcripts UUID.** Le dossier `~/.claude/projects/…agent-flow-1/` contient **plusieurs** `.jsonl` (reprises, redémarrages, sous-agents). La jointure `cwd→workspace_path` est donc **one-to-many** et **temporelle** : à un instant t, plusieurs UUID peuvent matcher un même worktree. Le front doit choisir la session **live la plus récente** (le relay ne surveille de toute façon que les transcripts récents, `ACTIVE_SESSION_AGE_S=600`).
- **Statuts riches du design absents de `SessionInfo`.** `status` = `'active' | 'completed'` seulement (`protocol.ts:34`). Les statuts du design (`running|review|blocked|idle|done`) doivent venir du **feed topologie AO** (`activity_state`) et/ou de la détection de permission déjà présente côté dashboard (`waiting_permission`), pas de `SessionInfo`.
- **`session_worktrees` vide** (0 ligne) → confirmé : la source canonique du worktree est bien `sessions.workspace_path`, pas cette table.

---

## Partie B — Risques d'architecture + correctifs

### B1 — (CRITIQUE) La clé de jointure n'est pas dans le contrat CLI
Le cœur de l'archi proposée (shell-out `ao … --json` → arbre avec `workspace_path` → jointure par chemin)
**ne tient pas** : `workspace_path` n'est renvoyé par **aucune** commande `ao … --json`. Deux correctifs :

- **Option 1 — Reconstruire le chemin depuis la convention AO** (sans DB) :
  - worker : `{AO_DATA_DIR}\worktrees\{projectId}\{id}` (vérifié pour tous les workers).
  - orchestrateur : `{AO_DATA_DIR}\worktrees\{projectId}\orchestrator\{projectId}-orchestrator`
    (⚠️ le dossier **n'est pas** l'id AO : `agent-flow-6` → dossier `agent-flow-orchestrator`).
  - Avantage : 100 % contrat CLI. Inconvénient : **couple à la convention de layout** d'AO (aussi fragile qu'un couplage schéma, et casse sur worktree custom).
- **Option 2 — Lire `workspace_path` dans `ao.db` en read-only** (`file:…?mode=ro`, gérer le `-wal`) :
  - Ne lire que quelques colonnes **stables** (`id, project_id, kind, activity_state, is_terminated, workspace_path`) sous `try/catch` + dégradation si absente.
  - C'est la source **directe et exacte**. La recon la classait « plan B fragile » ; puisque la CLI ne fournit pas le champ, elle devient en pratique la **source de référence**, pas un plan B.

> **Reco** : **Option 2** (lecture DB ro ciblée) comme source de `workspace_path`, **enrichie** par `ao … --json`
> pour le statut/harness/role (contrat public). C.-à-d. hybride : CLI pour le vivant + statut, DB-ro pour le chemin.
> Fallback Option 1 (reconstruction) si la DB est illisible. **Ne jamais écrire** dans la DB (déjà la règle).

### B2 — Races / ordre au démarrage & topologie vivante
- La topologie **change pendant l'exécution** (preuve : `agent-flow-6` apparu en cours d'audit). Le feed doit
  **diffuser des diffs** et **rejouer le dernier snapshot** à chaque connexion SSE (comme `session-list`,
  `relay.ts:519-533`). Prévoir un `let lastTopology` module-level.
- Ordre `ao-topology` vs `session-list` non garanti côté client → le front doit tolérer un état où l'un arrive
  avant l'autre (matcher paresseusement `node.workspacePath` ↔ `SessionInfo.cwd` quand les deux sont là).

### B3 — Coût du polling + diff
2 appels CLI/cycle (~100 ms) toutes les 2-3 s = négligeable, **si** : (a) on ne diffuse que sur changement
(hash du snapshot) ; (b) timeout dur sur le shell-out (ex. 1,5 s) pour ne pas empiler les process si le daemon rame ;
(c) pas de `ao session get` par nœud en boucle (seulement au clic).

### B4 — Sessions terminées
`ao session ls` **masque les terminées par défaut** (`meta.hiddenTerminatedCount: 39` observé ; flag
`--include-terminated`). Le design a un statut `done` → décider : soit inclure les terminées récentes (via
`--include-terminated` ou `is_terminated` en DB) pour l'onglet « terminé » de la vue CLI, soit ne montrer que
le vivant. **Attention** : une session AO terminée n'a plus de transcript live → pas de drill-down intra-session possible.

### B5 — Multi-worktree même projet & multi-transcript même worktree
- Multi-worktree/projet : **OK** (jointure par `workspace_path` exact, unique). Déjà géré par la Phase 1.
- Multi-transcript/worktree (angle mort A) : au drill-down, choisir la **session live la plus récente** dont
  `cwd === node.workspacePath` ; ignorer les UUID inactifs.

### B6 — Daemon down / hors AO
`ao status` KO ou `ao.db` absent → **feature masquée** (toggle absent), Phases 1/2 intactes. Shell-out en échec →
garder le dernier snapshot marqué « stale » plutôt que vider l'écran.

### B7 — Impact Phases 1/2
Faible et **additif** : `cwd` déjà présent (A6) ; la nouvelle maille est un 3ᵉ mode à côté de `single`/`split` ;
**seul point de refacto** : généraliser `SplitView` (aujourd'hui typé `sessions: SessionInfo[]` + rend `SessionPane`
en dur, `split-view.tsx:13-17,81`) pour accepter des volets hétérogènes. Voir C1.

---

## Partie C — Architecture front (ce que la recon n'a pas couvert)

### Fait structurant (pivot de toute la reco)
`AgentCanvas` est **agnostique de la source** : il lit un `SimulationState` (`{ agents: Map, edges: Edge[],
toolCalls, discoveries, particles }`) via une **ref** et le dessine (`canvas.tsx:26-44,91-103,178-283`). À l'inverse,
`useAgentSimulation` est le **moteur transcript→état** couplé aux events Claude/Codex (d3-force + `processEvent`,
`use-agent-simulation.ts:24,162-282`). 

**Conséquence** : la Constellation `VOUS → orchestrateur → workers` a des nœuds = **sessions AO** (pas des agents
intra-session). On **réutilise la couche de rendu** (`AgentCanvas` + `web/components/agent-visualizer/canvas/`
`draw-agents/draw-edges/hit-detection/…`) mais **PAS** `useAgentSimulation`. On alimente le canvas avec un
`SimulationState` **fabriqué depuis la topologie**.

### C1 — Constellation + vue scindée (mapping design → composants)

1. **`useTopologyGraph(topology, { rootLabel:'VOUS' })`** (nouveau hook) :
   - construit un `SimulationState` synthétique : 1 nœud `Agent` par session AO (orchestrateur + workers) + 1 nœud
     racine « VOUS » ; `edges` `parent-child` `VOUS→orch` et `orch→worker` ;
   - layout via le **même** `forceSimulation` d3-force que `useAgentSimulation` (extraire l'init `forceSimulation`
     en util partagé) ; pas d'horloge d'events, juste un re-layout quand la topologie change ;
   - mappe `status` design → couleur : `activity_state` AO (`active/idle/exited/blocked/waiting_input`) +
     `SessionInfo.status` + `waiting_permission` (détection déjà existante) → `getStateColor`.
2. **`OrchestratorPane`** (calqué sur `SessionPane`, `session-pane.tsx`) : un `useTopologyGraph` + un `AgentCanvas`
   + `useSelectionState`. Bandeau `projet › orchestrateur › needs(#review/#blocked)`. Bouton **`⇄`** (cycler
   l'orchestrateur du volet) + **clic sur orchestrateur périphérique = recentrer** (le design a tranché : pas de
   « remplacement » de panneau ; les workers orbitent, toujours visibles).
3. **Réutiliser `SplitView` en le généralisant** : aujourd'hui il rend `SessionPane` en dur. Le transformer en
   **coquille de layout** (grille 1/2/4 + poignées, déjà faites `split-view.tsx:26-129`, `MAX_PANES`) prenant un
   `renderPane(item, {focused,onFocus})` (render-prop) ou une liste discriminée `{kind:'session'|'orchestrator'}`.
   → 1 volet = 1 `OrchestratorPane` ; split 1/2/4 = « comparer N orchestrateurs ».
4. **Maille sélectionnable** dans `index.tsx` : remplacer le booléen `splitView` (`index.tsx:80,281-287`) par
   `mesh: 'single' | 'split' | 'orchestrator'`, la maille `orchestrator` **gatée** sur `topology.underAo`.
   Toggle dans `TopBar` à côté du bouton `Split` (`top-bar.tsx:169-171`).
5. **Drill-down = la jointure en action** (optionnel v1.1) : au clic sur un worker, résoudre
   `node.workspacePath` (normalisé `foldPathCase`+`realpathSync`, déjà dispo `fs-utils`) ↔ `SessionInfo.cwd` live
   le plus récent → `sessionId` (UUID) → `bridge.openSessionFeed(sessionId)` → afficher un **`SessionPane`** (le
   vrai essaim intra-session). C'est le pont Phase 2 ↔ Phase 3.

### C2 — Vue CLI + canal d'écriture (actions)

- **Vue CLI** : composant arbre `orchestrateur → workers` (React pur, pas de canvas), alimenté par le **même**
  feed topologie. Glyphes de statut + filtres `tous/en cours/avis/bloqué/terminé` (map `activity_state` +
  `waiting_permission` + `is_terminated`). Aucune dépendance nouvelle.
- **Back-channel (écriture)** — état actuel : le flux est **strictement sortant** (SSE `es.onmessage →
  window.postMessage`, `use-vscode-bridge.ts:98-103`). Le **seul** canal entrant est le `HookServer` (events du
  hook, pas du webview). Il faut donc **créer** un canal `webview → relay → ao` :
  1. endpoint HTTP **POST** sur le serveur app (`app/src/server.ts`, à côté de `/events`) — ex. `POST /command
     {action, sessionId, text}` ;
  2. le relay exécute le shell-out : `ao send <id> "<msg>"`, `ao spawn …`, `ao session kill/restore <id>` ;
  3. côté client, ajouter `sendCommand()` au bridge (`fetch('/command')` en standalone / `vscodeBridge.postMessage`
     en VS Code).
- **Limite connue à intégrer dans l'UI** : un worker en `SESSION_AWAITING_DECISION` (prompt de permission d'outil)
  **n'est pas approuvable via `ao`** (interactif dans la session). Donc « débloquer » = **envoi d'un message de
  guidage** (`ao send`), **pas** l'approbation d'une permission. L'UI doit libeller clairement les deux
  (« Donner un avis » = message ; pas de bouton « Approuver »). **Reco de scope** : v1 **CLI read-only + `ao send`**
  seulement ; `spawn`/`kill`/`restore` en v1.1 (irréversibles → confirmation).

---

## Plan d'implémentation consolidé (lots, effort, ordre)

| Lot | Contenu | Effort | Dépend de |
|---|---|---|---|
| **L0** | *(déjà livré Phase 1)* `cwd` dans `SessionInfo` + propagation relay | ~~S~~ **fait** | — |
| **L1** | `isUnderAo()` (env + `ao status` + présence `ao.db`) ; helper résolution binaire `ao` (PATH + fallback `resources/daemon/ao(.exe)`) | **XS** | — |
| **L2** | `ao-topology-source.ts` : shell-out `orchestrator ls`+`session ls --json` (statut/role) **+ lecture DB ro** pour `workspace_path` (fallback reconstruction), timeout dur, arbre `projects[].{orchestrators[],workers[]}` | **M** | L1 |
| **L3** | Canal SSE `ao-topology` : `broadcast` diff-only (hash), rejeu `lastTopology` à la connexion, poll 2-3 s dédié | **S** | L2 |
| **L4** | Types partagés `AoTopology`/`AoNode` (`protocol.ts` ↔ `bridge-types.ts`, miroir) + intégration bridge (`onTopology`) | **S** | L3 |
| **L5** | Généraliser `SplitView` en coquille de layout (render-prop / volets discriminés) — non-régression Phase 2 | **S** | — |
| **L6** | `useTopologyGraph` (SimulationState synthétique + d3-force partagé + map statut→couleur) | **M** | L4 |
| **L7** | `OrchestratorPane` (canvas topo + `⇄` cycler + recentrer) + maille `mesh:'orchestrator'` gatée `underAo` + toggle TopBar | **M** | L5,L6 |
| **L8** | Vue **CLI** (arbre + filtres + glyphes) sur le même feed | **M** | L4 |
| **L9** | Back-channel `POST /command` (app server) + `bridge.sendCommand()` + `ao send` (guidage) ; libellés limite permission | **M** | L4 |
| **L10** | Drill-down worker → `SessionPane` live via jointure `workspacePath↔cwd` (pont Phase 2) | **S** | L6,L7 |
| **L11** | Robustesse/tests : projets 0..N orch, casse Windows, daemon down, topo vivante/diffs, terminées ; tests `deriveProject`/mapping | **M** | tous |

**Ordre recommandé** : L1 → L2 → L3 → L4 (socle données, testable en isolation) ; puis **en parallèle** L5+L6→L7
(Constellation) et L8 (CLI) ; L9 (actions) après L4 ; L10 en finition ; L11 en continu.
**Cœur données L1-L4 ≈ M** (surcoût vs recon dû à L2 : DB-ro + reconstruction, pas un simple parse CLI).
**UI L5-L8 ≈ L cumulé**. **Total ≈ L.**

---

## Synthèse condensée

1. **Jointure `cwd === workspace_path` : valeur CONFIRMÉE à l'octet** (transcript vs `ao.db`).
2. **Correction majeure** : `workspace_path` **n'est dans AUCUNE sortie `ao … --json`** — le transport « shell-out
   CLI » proposé **ne fournit pas la clé de jointure**. Il faut lire `ao.db` en **read-only** (source de référence)
   ou reconstruire le chemin par convention (fragile). Hybride recommandé : CLI pour statut/role + DB-ro pour le chemin.
3. `agent_session_id` **vide (0/45)**, **aucune colonne de parenté**, `session_worktrees` **vide** : tous CONFIRMÉS
   en DB. Parenté = implicite par `project_id` + `kind`.
4. **À nuancer** : « agent-flow sans orchestrateur » est **faux maintenant** (`agent-flow-6` orch. apparu **en
   direct** pendant l'audit) → gérer **0..N orch/projet** dynamiquement + diffs de topologie vivante.
5. **REST :3001 = 404 confirmé** ; latence CLI ~45-50 ms/appel (2 appels/poll) ; polling 2-3 s dédié (≠ `SCAN_INTERVAL=1s`).
6. **Sessions terminées masquées par défaut** (`--include-terminated`), à décider pour l'onglet « terminé ».
7. **`cwd` dans `SessionInfo` est DÉJÀ livré (Phase 1)** — la reco « ajouter cwd » est obsolète.
8. **Angle mort** : 1 session AO ↔ N transcripts UUID → prendre la session live la plus récente au drill-down.
9. **Front** : `AgentCanvas` est **réutilisable** (agnostique de la source, lit un `SimulationState` par ref) ;
   `useAgentSimulation` **ne l'est pas** (couplé transcript). Constellation = nouveau `useTopologyGraph` +
   `OrchestratorPane` + `SplitView` généralisé en coquille.
10. **Actions** : flux 100 % sortant aujourd'hui → créer `POST /command` (app server) → `ao send`. Limite dure :
    `SESSION_AWAITING_DECISION` **non approuvable via `ao`** → « débloquer » = message de guidage, pas d'approbation.
11. **Plan** : L1-L4 socle données (≈ M), L5-L8 UI Constellation+CLI (≈ L), L9 actions, L10 drill-down, L11
    robustesse. Impact Phases 1/2 faible et additif (seul refacto : généraliser `SplitView`).
