# Brief R2 — Parenté orchestrateur → workers dans AO

**Fichier de sortie** : `docs/recon-briefs/out/R2-parente-orchestrateur-workers.md`

## Mission
Déterminer **comment reconstruire le graphe orchestrateur → workers** : quel(s) champ(s) AO relie(nt)
un worker à l'orchestrateur qui l'a spawné.

## À inspecter
- `ao orchestrator ls --json` (liste des orchestrateurs) vs `ao session ls -a --json` (tous, dont
  orchestrateurs) et `ao session get <id> --json` sur un worker ET un orchestrateur.
- Cherche un champ explicite : `parentId` / `orchestratorId` / `spawnedBy` / `createdBy` / similaire.
- Store AO **`C:\Users\nicol\.ao\data`** (LECTURE SEULE) : le lien de parenté y est-il persisté ?
  sous quelle forme (fichier, champ, relation projet) ?
- `role` (`worker` vs `orchestrator`), `projectId`, branche/worktree : suffisent-ils à déduire la
  parenté si aucun champ explicite ?

## Questions précises
1. Existe-t-il un champ de parenté explicite ? Lequel, où (CLI et/ou store) ?
2. Sinon, quelle **heuristique de dérivation** (par projet ? par arbre de worktrees ? par timestamp
   de spawn ?) et quelle fiabilité ?
3. Un orchestrateur peut-il avoir 0 worker ? un worker être orphelin (sans orchestrateur) ? Comment
   les représenter dans le modèle `Orchestrator { workers[] }` du design (cf. RECON §8) ?
4. Un même projet peut-il avoir plusieurs orchestrateurs ? (impacte l'hypothèse « 1 orch = 1 projet »)

## Livrable
Reco : mapping exact données AO → `Orchestrator{ id,name,workers[] }` + Worker, avec fallback.
