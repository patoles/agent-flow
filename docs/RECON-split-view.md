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
- Non fait (Phase 2, stretch) : panneaux splittables redimensionnables (multi-canvas).
