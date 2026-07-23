# RECON — Regroupement par projet / worktree + vue splittable

> Fork local de `patoles/agent-flow`. Cible : app standalone (`app/` + son dashboard buildé depuis `web/`).
> Objectif : quand plusieurs sessions AO tournent, pouvoir **grouper par projet puis worktree** (dérivés du `cwd`) et **choisir ce qu'on voit** (filtre et/ou panneaux splittables), tout en gardant le comportement actuel en fallback.

## 1. Architecture réelle (vérifiée)

### Flux de données (mode `npx agent-flow-app -p 4100`)

```
Claude Code ──(hook)──> ~/.claude/agent-flow/hook.js ──HTTP POST──┐
                                                                   ▼
~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl ──watch──> scripts/relay.ts
                                                                   │  (HookServer + TranscriptParser + scan)
                                                                   ▼  SSE  /events
                        web (build Vite) → app/dist/webview/  ── EventSource ──> window.postMessage
                                                                   ▼
                        vscodeBridge → useVSCodeBridge → useAgentSimulation → AgentCanvas
```

- **`app/`** = paquet standalone (`agent-flow-app`, bin `dist/app.js`). *Hors workspace pnpm* (le workspace ne contient que `extension` + `web`). Point d'entrée `app/src/app.ts` → `startServer` (`app/src/server.ts`).
- **Serveur** (`app/src/server.ts`) : un `http.Server` qui sert `/events` (SSE via `createRelay`) et les assets statiques (`app/src/static.ts`, sert `app/dist/webview/`). Écoute sur `127.0.0.1:<port>`.
- **Relay** (`scripts/relay.ts`, partagé dev + app) : `HookServer` reçoit les events du hook ; `TranscriptParser` + `scanForActiveSessions` surveillent les `.jsonl` sous `~/.claude/projects`. Émet des `AgentEvent` et un cycle de vie de session sur SSE.
- **Dashboard** = `web/` buildé par `web/vite.config.app.ts` (entry `web/app-entry.tsx` → `<AgentVisualizer/>`) vers `app/dist/webview/`. `build:app` = `node app/build.js` (Vite webview + esbuild du bundle Node).
- **Port** : défaut = `DEFAULT_RELAY_PORT` (3001, `extension/src/constants`). Le 3001 est pris par le daemon AO → **toujours lancer avec `-p 4100`** (crash EADDRINUSE sinon). Le flag est déjà géré (`app/src/args.ts`).

### Modèle de session / évènement

- `AgentEvent { time, type, payload, sessionId? }` — `extension/src/protocol.ts`.
- `SessionInfo { id, label, status, startTime, lastActivityTime }` — **aucun champ projet / worktree / cwd aujourd'hui**. Dupliqué côté client dans `web/lib/bridge-types.ts` (doit rester en miroir de `protocol.ts`).
- `WatchedSession` (état serveur par session) connaît `filePath` mais pas le `cwd` métier.

### UI multi-session existante

- **Des onglets existent déjà** : `web/components/agent-visualizer/session-tabs.tsx`, montés dans `top-bar.tsx` (visibles seulement si `sessions.length > 1`).
- **Mais une seule session est rendue à la fois** : `useAgentSimulation` prend `sessionFilter = selectedSessionId` ; un seul `<AgentCanvas/>`, un seul état de simulation. Le changement d'onglet fait save/restore d'un snapshot (`index.tsx`, `sessionCacheRef`).
- **Le « side-by-side » du README n'est PAS un split de panneaux** : il désigne l'affichage conjoint des runtimes Claude + Codex dans **la même** liste de sessions, taggés par runtime (`README.md` l.21/66). Le « Multi-session support » = ces onglets. → **Aucun vrai split / panneau redimensionnable n'existe** : rien à réinventer de ce côté, mais tout à construire.

### D'où vient le projet + worktree ? (point clé validé)

- Le `cwd` de chaque session est présent dans les entrées JSONL Claude (vérifié : **76/105 lignes** du transcript courant portent `cwd`, ex. `C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1`).
- Le hook (`scripts/setup.js`, contenu de `hook.js`) lit et forwarde aussi le `cwd`.
- **Décoder le nom du dossier `~/.claude/projects/<encoded>` est non fiable** : tous les séparateurs deviennent `-`, donc `...worktrees-agent-flow-agent-flow-1` ne permet pas de séparer projet/worktree sans ambiguïté. → **Source retenue : le `cwd` réel lu dans le JSONL** (le `TranscriptParser` parse déjà chaque entrée : `prescanExistingContent` l.430, `processTranscriptLine` l.98).

Règles de dérivation (client) :
| Motif de `cwd` | projet | worktree |
|---|---|---|
| `…\.ao\data\worktrees\<projet>\<session>\…` | `<projet>` | `<session>` |
| `…\PROJETS\<projet>[\…]` | `<projet>` | `—` (ou premier sous-dossier) |
| autre | dernier segment du chemin | `—` |

## 2. Plan d'implémentation

Découpé en 2 phases. **Phase 1 = livrable principal** (groupement + filtre, fallback préservé). **Phase 2 = stretch** (split redimensionnable).

### Phase 1 — Plomberie `cwd` + groupement + filtre

1. **Serveur — capter le `cwd`**
   - `WatchedSession` : ajouter `cwd: string | null` (`extension/src/protocol.ts`).
   - `TranscriptParser` : dans `prescanExistingContent` / `processTranscriptLine`, si l'entrée porte `cwd` et que `session.cwd` est vide → l'enregistrer.
   - `relay.ts` : inclure `cwd` dans `SessionInfo` lors de `broadcastSessionLifecycle('started')`, dans la `session-list` du `handleSSE`, et lors du `watchSession` initial.
2. **Protocole**
   - Ajouter `cwd?: string` à `SessionInfo` dans `extension/src/protocol.ts` **et** `web/lib/bridge-types.ts` (miroir).
3. **Client — dérivation**
   - Nouveau util `web/lib/session-grouping.ts` : `deriveProjectWorktree(cwd?) → { project, worktree }` (+ tests unitaires, cf. `format-model-name.test.ts` comme modèle).
4. **Client — UI de groupement + filtre**
   - Remplacer les onglets à plat par un rendu **groupé projet → worktree** (en-têtes de groupe + onglets, ou arbre repliable) dans `session-tabs.tsx` / `top-bar.tsx`.
   - Ajouter un **sélecteur de filtre** (projet et/ou worktree) qui restreint la liste des sessions visibles. État local dans `AgentVisualizer` ; par défaut « tout » = comportement actuel.
   - Fallback : si aucun `cwd` (Codex, anciens transcripts) → groupe « Autres », onglets comme aujourd'hui.

### Phase 2 — Panneaux splittables (stretch)

Contrainte structurelle : `useAgentSimulation` est **mono-instance** liée à `selectedSessionId` (un seul canvas). Un vrai split N sessions côte à côte impose N instances de simulation + N canvas.

- Extraire un composant `SessionPane` = un `useAgentSimulation` + `<AgentCanvas/>` paramétrés par un `sessionId` fixe (retirer la dépendance à l'unique `selectedSessionId`).
- Layout splittable redimensionnable (grille 1×N / 2×2) avec poignées de redim. Réutiliser un pattern maison léger plutôt qu'une lib (pas de dépendance externe imposée — cf. contrainte supply-chain).
- Le save/restore de snapshot par onglet devient inutile en mode split (chaque pane garde son propre état).

## 3. Points d'attention / risques

- **Miroir de types** : `protocol.ts` ↔ `bridge-types.ts` doivent rester synchronisés (commentaire déjà présent). Tout ajout de champ va aux deux endroits.
- **Perf split (Phase 2)** : N canvas animés = N `requestAnimationFrame` + audio. Prévoir de couper l'audio hors pane focalisé et de plafonner N.
- **Codex** : pas de `cwd` garanti → doit tomber proprement dans le groupe « Autres ».
- **Rebuild obligatoire** : le dashboard est **pré-buildé** dans `app/dist/webview/`. Toute modif `web/` n'apparaît qu'après `pnpm run build:app`. Pas de HMR en mode app.
- **Marque / licence** : Apache-2.0, OK en usage local. Ne pas réutiliser marque/logos en cas de redistribution (`TRADEMARK.md`).

## 4. Estimation d'effort

| Lot | Détail | Effort |
|---|---|---|
| 1. Plomberie `cwd` (serveur + protocole) | parser + relay + 2 types | **S** (~½ j) |
| 2. Util dérivation + tests | `session-grouping.ts` | **XS** (~1–2 h) |
| 3. UI groupement + filtre | tabs groupés + sélecteur | **M** (~1 j) |
| 4. Build + vérif `-p 4100` + doc lancement | build:app, smoke test | **XS** |
| **Phase 1 (livrable principal)** | lots 1–4 | **~2 j** |
| 5. Panneaux splittables redimensionnables | multi-canvas, refacto simulation | **L** (~2–3 j) |

**Recommandation** : livrer **Phase 1** d'abord (groupement projet→worktree + filtre, fallback intact) — c'est ce qui résout directement le « 1 conversation = toute la page ». Décider ensuite si la Phase 2 (split) est nécessaire ou si le filtre suffit.

## 5. Commande de lancement du fork

```bash
corepack pnpm install       # pnpm absent du PATH → passer par corepack
node app/build.js           # build web (Vite) + bundle app (esbuild) → app/dist/
node app/dist/app.js -p 4100   # OBLIGATOIRE : -p 4100 (3001 = daemon AO)
# dashboard : http://127.0.0.1:4100
```

Gotchas rencontrés à la vérif :
- **Ne pas passer par `pnpm run build:app`** : le wrapper `pnpm run` relance un check de
  dépendances qui échoue (`ERR_PNPM_IGNORED_BUILDS` sur esbuild/sharp) et interrompt le build.
  Lancer directement `node app/build.js` (esbuild fonctionne, le postinstall ignoré est sans effet ici).
- **Port 4100 déjà occupé** par une instance `npx agent-flow-app` publiée peut donner un
  `EADDRINUSE` : vérifier avec `netstat -ano | grep :4100`. Pour un test isolé de ce fork sans
  toucher à l'instance en cours, lancer sur un autre port libre (ex. `-p 4101`).

## 6. Statut — Phase 1 livrée

- Plomberie `cwd` : `WatchedSession.cwd`, capté par `TranscriptParser` (Claude) et
  `CodexSessionWatcher` (via `session_meta`), remonté dans `SessionInfo` (SSE + webview).
- Client : `deriveProjectWorktree` / `groupSessions` (8 tests unitaires) + composant `SessionNav`
  (dropdown de filtre projet/worktree + groupes repliables) ; fallback plat conservé quand il n'y
  a qu'un projet.
- Vérif : `node app/build.js` OK ; 40 tests OK ; `tsc --noEmit` OK (web + extension) ; smoke test
  sur `-p 4101` → dashboard servi + `cwd` présent dans le SSE (`…\worktrees\agent-flow\agent-flow-1`).

## 7. Statut — Phase 2 livrée (MVP)

Panneaux splittables N sessions côte à côte. Mode **OFF par défaut** : le mono-session reste le
fallback intact.

- **Bridge** : flux par session découplé de `selectedSessionId` (`openSessionFeed` / `consumeSessionFeed`
  / `closeSessionFeed`) — chaque pane consomme le backlog + le live de SA session, tableau muté en place.
- **`SessionPane`** (`session-pane.tsx`) : un `useAgentSimulation` + un `useSelectionState` + un
  `<AgentCanvas/>` par `sessionId` fixe. Bandeau projet › worktree › label + nb agents. Carte détail
  agent au clic (contenue dans le pane). Audio **uniquement sur le pane focalisé** (maps vides ailleurs).
- **`SplitView`** (`split-view.tsx`) : grille 1×N / 2×2 avec poignées de redim (fractions
  colonne/ligne draggables, **sans lib**). Plafond `MAX_PANES = 4` avec notice si dépassement.
- **Toggle « Split »** dans le `TopBar` (visible seulement avec des sessions live) ; réutilise le
  filtre projet/worktree de la Phase 1 pour choisir les sessions affichées.
- **Hors périmètre MVP** (le mono-session les conserve) : timeline / seek / transcript par pane,
  pop-ups outil & discovery en split, contrôle mute partagé (le pane focalisé respecte la préf. mute
  persistée). `AgentCanvas` se dimensionne à son parent → aucune modif du canvas nécessaire.
- **Vérif** : `node app/build.js` OK ; `tsc --noEmit` OK (web) ; 8 tests grouping OK ; smoke test
  `-p 4137` → dashboard servi (200, `#root`).

## 8. Phase 3 — Vue « par orchestrateur » (spec, à recon+planifier)

**Besoin utilisateur.** Aujourd'hui la barre du haut affiche autant de conversations que de
terminaux, alors que plusieurs workers dépendent d'un même **orchestrateur**. On veut :
1. une **maille haute** qui ne montre QUE les orchestrateurs (workers masqués) ;
2. le **split** = 2 orchestrateurs côte à côte (écran scindé, un par orchestrateur) ;
3. un **drill-down** : clic sur un orchestrateur → ses **workers AO**.

### Clarifications

#### Session 2026-07-20
- Q: Qu'est-ce qu'un « orchestrateur » à afficher ? → R: **les sessions `role: orchestrator` du daemon AO** (`ao orchestrator ls`, ex. `intermitapp-1`, `sync-1`) — notion native, pas d'heuristique.
- Q: Comment récupérer la hiérarchie orchestrateur→workers ? → R: **le relay interroge le daemon AO** et diffuse le graphe (assume une dépendance AO côté fork).
- Q: Sort du split par session (Phase 2) ? → R: **nouveau mode « par orchestrateur » EN PLUS** ; le split par session reste, bascule via un toggle de maille (fallback intact).
- Q: Comportement du drill-down en split ? → R: **remplace le panneau cliqué** par la vue de ses workers ; l'autre orchestrateur reste affiché à côté.
- Différé → **résolu par le design** (voir « Référence design ») : un panneau orchestrateur = un **mini-graphe `VOUS → orchestrateur → workers`** (les workers orbitent, toujours visibles), pas un canvas d'orchestrateur seul.
- Note : le design **fait évoluer** la réponse Q4. Il n'y a pas de « drill-down qui remplace le panneau » : les workers sont **toujours affichés** autour de leur orchestrateur ; l'interaction est **recentrer** (vue pleine, clic sur un orchestrateur périphérique) et **`⇄` cycler** l'orchestrateur d'un volet (vue scindée).

### Exigences dérivées
- **Deux mailles** sélectionnables (toggle) : *par session* (Phase 2, inchangé) et *par orchestrateur* (nouveau). Le mono-session reste le défaut.
- **Maille orchestrateur** : liste = sessions `role: orchestrator` d'AO. Split 1×2 (un orchestrateur par moitié), poignées réutilisées de la Phase 2.
- **Drill-down** : état par panneau `{ orchestratorId, drilled: bool }` ; drilled → le panneau rend les workers de cet orchestrateur (grille interne ou onglets), l'autre panneau inchangé ; bouton retour vers la maille orchestrateur.
- **Données** : le relay expose un **graphe de sessions AO** (orchestrateurs + leurs workers) via SSE, en plus des events actuels.

### Référence design (Claude Design) — source de vérité hi-fi
Projet claude.ai/design **« Agent Flow projet organisation »** (`002eba0a-…`), dossier
`design_handoff_orchestrateurs/` : `README.md` (spec + tokens exacts), `Orchestrateurs.dc.html`
(prototype), `support.js` (runtime proto, **pas** à porter). `Couche Projets.dc.html` = 4
explorations initiales (rail / barre / galerie / constellation). **À recréer dans le codebase
React/TS existant** en réutilisant les composants nœuds/arêtes/terminaux du repo (ne pas embarquer
le HTML ni support.js).

Le design définit **une couche à deux vues commutables** (pas seulement un split) :
- **Constellation** — graphe spatial `VOUS → orchestrateur → workers`. Vue pleine : orchestrateur
  central + 5 workers en orbite + orchestrateurs périphériques cliquables (**clic = recentrer**).
  Split **1 / 2 / 4 volets** : chaque volet = mini-graphe d'un orchestrateur ; bouton **`⇄`** cycle
  l'orchestrateur du volet. (C'est ça, le « scinder pour comparer 2 orchestrateurs ».)
- **CLI** — vue de triage terminal : arbre `orchestrateur → workers` avec glyphes de statut,
  filtres (`tous/en cours/avis/bloqué/terminé`) et actions (`donner un avis`/`débloquer`). C'est la
  maille « repérer en un coup d'œil où intervenir ».

Modèle de données du design : `Orchestrator { id,name,mono,accent,branch,tokens,cost, workers:Worker[] }`,
`Worker { id,name,status,role,msg,tok }` ; `status ∈ running|review|blocked|idle|done`,
`role ∈ bash|thinking|claude|user`. Dérivations : `orchStatus` (priorité blocked>review>running>done>idle),
`needs` (# workers review|blocked), `needColor`. Tokens/couleurs/glyphes/géométrie : valeurs exactes
dans le README (hi-fi, à reproduire). **Toutes les données du proto sont factices.**

⚠️ Le design **présuppose** `Orchestrator.workers[]` déjà disponible côté store — c'est précisément
l'objet des points de recon ci-dessous (comment le relay obtient ce graphe et le rattache aux
sessions réelles du dashboard).

### Points de recon BLOQUANTS (à lever avant de planifier l'implémentation)
1. **Clé de jointure AO ↔ dashboard.** Le dashboard identifie les sessions par **UUID de session Claude Code + `cwd`** (hook), PAS par id AO (`sync-1`). Le graphe AO utilise des ids AO. Il faut une clé commune pour rattacher chaque session vue par le dashboard à un orchestrateur AO — candidat le plus probable : le **chemin de worktree = `cwd`**. À valider.
2. **Champ de parenté orchestrateur→workers dans AO.** `role` seul ne donne pas le parent. Vérifier `ao session get <id> --json` / l'API daemon pour un `orchestratorId`/`parentId`, ou déduire par projet+worktree.
3. **Canal relay → daemon AO.** Le relay (app standalone) peut-il appeler la CLI `ao` (présente dans le PATH ?) ou l'API HTTP du daemon ? Définir le transport + le polling/refresh.
4. **Portabilité.** Cette maille dépend d'AO ; hors AO (usage VS Code pur) elle doit se désactiver proprement (toggle absent), la Phase 1/2 restant fonctionnelles.
5. **Canal d'écriture / commandes (CLI actionnable).** La vue CLI du design prévoit des actions
   (`donner un avis`, `débloquer`, `intervenir`). Le dashboard est aujourd'hui **read-only** (flux
   `hook → relay → SSE → webview` à sens unique). Il faut un **back-channel** `webview → relay → AO`
   (`ao send`, `ao session kill/restore`, `ao spawn`) — même transport que la lecture du graphe.
   **Limite connue** : un worker bloqué sur un prompt de permission (`SESSION_AWAITING_DECISION`)
   n'est **pas** approuvable via `ao` (interactif dans la session) → « débloquer » = envoi d'un
   message de guidage, PAS l'approbation d'une permission d'outil. Décision de scope : CLI
   read-only d'abord vs actionnable en v1.

### Statut recon (2026-07-20)
- **R1–R4 RÉSOLUS** par la session `agent-flow-2` → rapport complet : `docs/RECON-orchestrator-view.md`.
  Clé de jointure `normalize(cwd)===normalize(sessions.workspace_path)` (validée à l'octet ; l'UUID
  Claude n'est pas dans AO) · parenté implicite par `project_id` (orchestrateur = `kind='orchestrator'` ;
  ⚠️ agent-flow & launcher n'ont pas d'orchestrateur) · transport = shell-out `ao … --json` (~37 ms,
  polling 2-3 s ; REST daemon :3001 en 404) · détection AO = env `AO_*` + `ao.db` + `ao status`.
  Archi proposée : module `scripts/ao-orchestrator-source.ts` + canal SSE `ao-topology` + champ `cwd`
  dans `SessionInfo`. Effort cœur ≈ S, UI ≈ M.
- **R5–R6 OUVERTS** (archi composants front Constellation/split + vue CLI/actions) → confiés au worker
  d'audit `agent-flow-3` (`analyse-recon`), briefs dans `docs/recon-briefs/` (00 + R7).

### Couverture de clarification (spec-clarify)
| Catégorie | Statut |
|---|---|
| Fonctionnel | Clear (mailles, split, drill-down définis) |
| Données & volumétrie | Partial → recon #1/#2 (clé de jointure, parenté) |
| Perf / NFR | Clear (N≤2 orchestrateurs en split, même budget que Phase 2) |
| Edge cases | Deferred (orchestrateur sans worker, worker orphelin) → au plan |
| Terminologie | Clear (orchestrateur = `role: orchestrator` AO) |
| Interfaces | Partial → recon #3 (canal relay↔daemon) |
| Sécurité / PII | Clear (N/A, local) |
| Hypothèses | Partial → recon #4 (portabilité hors AO) |
