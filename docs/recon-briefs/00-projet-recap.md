# Récap projet — recon Phase 3 « vue orchestrateur » (agent-flow)

> Fichier commun injecté à **tous** les workers de recon. Lis-le en entier avant ta mission.

## Règles (IMPORTANT)
- **LECTURE SEULE partout**, sauf l'écriture de TON rapport dans `docs/recon-briefs/out/`.
- **Ne modifie JAMAIS** `~/.ao/data` (`C:\Users\nicol\.ao\data`) — c'est le store live du daemon AO.
- **Aucune commande destructrice** (pas de `rm`, `git reset`, `kill`, écriture hors de ton rapport).
- **Le codebase à inspecter est le worktree suivant** (il contient les Phases 1/2 déjà livrées) :
  `C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1`
  ⚠️ **PAS ton propre checkout** (spawné sur `main`, sans les Phases 1/2). Lis toujours via ce
  chemin absolu.
- Fournis des **preuves** (extraits de fichiers avec chemins, sorties de commandes).

## Le projet
Fork local du dashboard **agent-flow** (visualiseur d'agents, écran sombre « mission control »).
Monorepo pnpm : `app/` (app standalone, port 4000/4100), `web/` (Next.js, le dashboard), `extension/`
(VS Code). Flux de données **à sens unique** aujourd'hui :
`Claude Code → hook (~/.claude/agent-flow/hook.js) → HTTP POST → relay (scripts/relay.ts) → SSE /events → webview`.

## État livré (Phases 1 & 2) — sur ce worktree
- **Phase 1** : groupement des sessions par **projet/worktree** dérivé du `cwd`. Clés :
  `web/lib/session-grouping.ts`, `web/components/agent-visualizer/session-nav.tsx`,
  `cwd` porté dans `SessionInfo` (`extension/src/protocol.ts`, `web/lib/bridge-types.ts`),
  capté par `extension/src/transcript-parser.ts` + relay.
- **Phase 2** : **split** N sessions côte à côte. Clés :
  `web/components/agent-visualizer/session-pane.tsx` (un `useAgentSimulation` + `AgentCanvas` par
  sessionId), `web/components/agent-visualizer/split-view.tsx` (grille redimensionnable),
  flux par session dans `web/hooks/use-vscode-bridge.ts` (`openSessionFeed`/`consume`/`close`).
- Canvas : `web/components/agent-visualizer/canvas.tsx` (+ `web/components/agent-visualizer/canvas/`
  pour les fonctions de dessin nœuds/arêtes), simulation : `web/hooks/use-agent-simulation.ts`.

## Objectif Phase 3 (ce qu'on prépare)
Une **couche « orchestrateur »** : maille haute ne montrant que les **orchestrateurs AO**
(`role: orchestrator`, cf. `ao orchestrator ls`), chacun regroupant ses **workers**. Deux vues
(design hi-fi déjà fait) : **Constellation** (graphe `VOUS → orchestrateur → workers`, split 1/2/4
volets) et **CLI** (arbre de triage `orchestrateur → workers` avec filtres + actions).

**Contexte design + points bloquants détaillés** : lis
`C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1\docs\RECON-split-view.md` **§8** (spec,
modèle de données, tokens, et les 5 points de recon).

## Livrable (convention commune)
Écris ton rapport dans
`C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1\docs\recon-briefs\out\<TON-FICHIER>.md`
(le nom exact est dans ton brief). Structure : Réponses point par point **avec preuves** → reco
concrète (où brancher dans le code) → risques → estimation d'effort (XS/S/M/L). Termine ta réponse
finale par une **synthèse condensée** (10-15 lignes).
