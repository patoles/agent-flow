# Brief R7 — Analyse / audit de la reconnaissance + plan consolidé

**Fichier de sortie** : `docs/recon-briefs/out/R7-analyse-recon.md`

## Contexte
Une session de recon (`agent-flow-2`, désormais fermée) a produit un rapport technique. Ta mission
n'est PAS de refaire la recon mais de **l'auditer** (vérifier, challenger, trouver les trous) et de
la **prolonger** sur ce qu'elle n'a pas couvert (l'architecture front).

## À lire d'abord (chemins absolus, worktree de référence)
- Le rapport à auditer :
  `C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1\docs\RECON-orchestrator-view.md`
- Le contexte design + points bloquants :
  `C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1\docs\RECON-split-view.md` (§8).
- Le code réel (Phases 1/2 incluses) sous
  `C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1\` — notamment `scripts/relay.ts`,
  `extension/src/session-watcher.ts`, `web/hooks/use-agent-simulation.ts`,
  `web/components/agent-visualizer/{canvas.tsx,session-pane.tsx,split-view.tsx,canvas/}`.

## Partie A — Audit des conclusions de la recon (avec contrôles INDÉPENDANTS)
Rejoue/verifie chaque affirmation clé et classe-la **CONFIRMÉ / À CORRIGER / À NUANCER**, preuve à l'appui :
1. **Jointure** `normalize(cwd) === normalize(sessions.workspace_path)` : re-teste sur 2-3 sessions
   réelles (compare `entry.cwd` d'un `.jsonl` au `workspace_path` d'`ao.db`). Vrai à l'octet ? casse Windows ?
2. **`agent_session_id` vide partout** dans `ao.db` (pas de jointure UUID) : reconfirme.
3. **Parenté implicite par `project_id`** (orchestrateur = `kind='orchestrator'`) + le **cas projets
   sans orchestrateur** (agent-flow, launcher) : est-ce bien géré/gérable ? plusieurs orchestrateurs/projet ?
4. **Transport** : `ao ... --json` (~37 ms), REST daemon :3001 en 404. Re-mesure la latence ; confirme
   qu'il n'y a pas d'API exploitable. Le polling 2-3 s est-il raisonnable (charge, fraîcheur) ?
5. **Détection "sous AO"** (env `AO_*` + `ao.db` + `ao status`) : le relay hérite-t-il vraiment des
   env `AO_*` selon son mode de lancement (app AO vs `npx agent-flow-app`) ? Signale les angles morts.

Rappelle **LECTURE SEULE** : ne modifie jamais `~/.ao/data` ; lis `ao.db` sur une COPIE si besoin (Python).

## Partie B — Challenge de l'architecture proposée
Le rapport propose : module `scripts/ao-orchestrator-source.ts`, canal SSE `ao-topology`, champ `cwd`
ajouté à `SessionInfo`. Critique : races/ordre au démarrage, coût du polling + diff, sessions
terminées, multi-worktree même projet, robustesse si daemon down, impact sur les Phases 1/2 existantes.

## Partie C — Ce que la recon N'A PAS couvert (à cadrer)
1. **Archi composants front — Constellation + vue scindée** : comment bâtir les 2 graphes du design
   (`VOUS → orchestrateur → workers`, split 1/2/4) dans le codebase React/TS en **réutilisant**
   `AgentCanvas`, `use-agent-simulation`, `SessionPane`/`SplitView` (Phase 2) et les fonctions de
   dessin de `web/components/agent-visualizer/canvas/`. Mapping design→composants du repo. Le design
   (tokens/géométrie/état) est décrit dans RECON-split-view.md §8 (référence hi-fi complète côté Claude Design).
2. **Vue CLI + canal d'écriture (actions)** : structure de la vue CLI (arbre/filtres), et le
   back-channel `webview → relay → ao send` pour prompter/gérer les agents ; intègre la **limite
   connue** (worker en `SESSION_AWAITING_DECISION` non approuvable via `ao`).

## Livrable
Dans `docs/recon-briefs/out/R7-analyse-recon.md` : (A) tableau d'audit CONFIRMÉ/À CORRIGER/À NUANCER,
(B) risques d'archi + correctifs, (C) reco d'archi front (composants, où brancher) pour Constellation/split
et CLI/actions, puis un **plan d'implémentation consolidé par lots** (L1…Ln) avec effort (XS/S/M/L) et
ordre recommandé. Termine par une synthèse condensée (10-15 lignes).
