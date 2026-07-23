# Brief R1 — Clé de jointure AO ↔ dashboard

**Fichier de sortie** : `docs/recon-briefs/out/R1-jointure-ao-dashboard.md`

## Mission
Le dashboard identifie une session par son **UUID de session Claude Code + son `cwd`** (venu du hook).
Le graphe orchestrateur/workers vit dans **AO** avec des **ids AO** (`sync-1`, `intermitapp-16`…).
Trouve la **clé commune fiable** pour rattacher une session vue par le dashboard à une session AO.

## À inspecter (chemins absolus dans le worktree de référence)
- `…\agent-flow-1\scripts\relay.ts` — comment est construit `SessionInfo.id` ? d'où vient `cwd` ?
- `…\agent-flow-1\extension\src\transcript-parser.ts`, `session-watcher.ts`,
  `codex-session-watcher.ts`, `protocol.ts`.
- `C:\Users\nicol\.claude\agent-flow\hook.js` — payload transmis (dont `cwd`).
- Store AO **`C:\Users\nicol\.ao\data`** (LECTURE SEULE) : structure, où sont stockées les sessions,
  quels champs (id AO, chemin de worktree, éventuel UUID de session Claude Code, projet, role).
- Commandes : `ao session ls --json`, `ao session get <id> --json`, `ao orchestrator ls --json`.

## Questions précises
1. Quelle est la représentation exacte de `SessionInfo.id` côté dashboard (UUID ? autre) ?
2. Une session AO stocke-t-elle le chemin de worktree ? l'UUID de session Claude Code ?
3. La clé de jointure = **chemin de worktree == `cwd`** tient-elle ? Valide concrètement en
   comparant un `cwd` réel remonté par le dashboard à un chemin de worktree AO (ex. une des sessions
   `intermitapp-*`).
4. Cas limites : session hors worktree AO, Codex sans cwd, chemins normalisés/symlinks.

## Livrable
Reco : quelle clé retenir + comment la calculer côté relay, avec le risque résiduel.
