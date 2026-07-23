# Brief R3 — Canal bidirectionnel relay ↔ daemon AO

**Fichier de sortie** : `docs/recon-briefs/out/R3-transport-relay-daemon.md`

## Mission
Définir le **transport** entre le relay agent-flow (app standalone) et le daemon AO, dans les **deux
sens** : (a) **lecture** du graphe orchestrateurs/workers, (b) **écriture** de commandes (prompter /
gérer les agents depuis la future vue CLI).

## À inspecter
- Y a-t-il une **API HTTP/socket** du daemon AO ? Cherche un port / fichier de conf / socket dans
  `C:\Users\nicol\.ao` (LECTURE SEULE) ; regarde `ao status --json`, `ao doctor`.
- Le binaire `ao` : chemin exact (`where ao`), fiabilité dans le PATH depuis le contexte du relay.
- `scripts/relay.ts` (worktree de référence) : où brancher un nouveau flux SSE (lecture) et un
  nouvel endpoint (écriture) sans casser l'existant.
- **Écriture** : `ao send --session <id> --message <txt>`, `ao session kill/restore/rename`,
  `ao spawn`. Tester `ao send` sur une session existante et **documenter** le résultat.
- **Limite connue à confirmer** : une session en `SESSION_AWAITING_DECISION` (prompt de permission)
  refuse `ao send` → vérifie et documente ce que renvoie exactement l'appel, et s'il existe (ou non)
  une commande AO pour approuver une permission.

## Questions précises
1. Lecture : shell-out `ao … --json` (polling — quelle fréquence ?) vs API daemon vs lecture directe
   de `~/.ao/data` ? Recommande **un** transport avec justification (latence, robustesse, couplage).
2. Écriture : même canal ? quelles actions réellement disponibles via `ao` ? lesquelles impossibles
   (ex. approbation de permission) ?
3. Où et comment câbler ça dans `relay.ts` (endpoint(s), format des messages) ?

## Livrable
Reco transport (lecture + écriture) + esquisse d'API relay (routes, payloads) + risques.
