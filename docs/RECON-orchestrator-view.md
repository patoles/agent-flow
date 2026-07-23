# RECON — Vue "par orchestrateur" (AO ↔ agent-flow)

> Recon **lecture seule**. Aucune modification du code ni du store live `~/.ao/data`.
> Date : 2026-07-20. Worktree : `C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-2` (session AO `agent-flow-2`).

## TL;DR

| Question | Réponse courte |
|---|---|
| Clé de jointure AO ↔ dashboard | **`normalize(cwd) === normalize(sessions.workspace_path)`** — validé empiriquement. Bonus : `AO_SESSION_ID` est déjà en env du process agent. |
| L'UUID Claude est-il dans AO ? | **Non.** `sessions.agent_session_id` est **vide partout**. Pas de jointure par UUID possible. |
| Parenté orch→workers | **Implicite** : groupe par `project_id`, l'orchestrateur = la session `kind='orchestrator'`. Aucun champ `parentId`. Certains projets n'ont pas d'orchestrateur. |
| Transport recommandé | **Shell-out `ao ... --json`** (contrat public, 37 ms/appel). Pas d'API REST exploitable ; lecture DB = plan B fragile. |
| Détection "sous AO" | **`AO_DATA_DIR`/`AO_SESSION_ID` en env** + présence de `~/.ao/data/ao.db` + `cwd` sous `.ao/**/worktrees/**`. |

---

## 1) Clé de jointure AO ↔ Dashboard

### 1.a — Comment le dashboard construit `SessionInfo.id`

**`SessionInfo.id` = UUID de session Claude Code = nom du fichier `.jsonl`.**

`scripts/relay.ts` (scan des sessions actives) :
```ts
// relay.ts:301
const sessionId = path.basename(file, '.jsonl')
...
// relay.ts:494 — ce qui est envoyé au webview
sessionList.push({ id: session.sessionId, label: session.label, ... })
```
Même logique côté extension (`extension/src/session-watcher.ts:346`, `:94-100`).

Pour **Codex**, l'id vient du nom de rollout via regex :
```ts
// codex-session-watcher.ts:38
const SESSION_ID_FROM_FILENAME = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/
// :264 → m[1] (l'UUID)
```

Donc l'identité d'une session côté dashboard est **l'UUID Claude/Codex**, jamais un id AO.

### 1.b — D'où vient `cwd`

Trois usages, une seule source de vérité utile pour la jointure :

1. **Le hook** ne transporte que `cwd` (pour router l'événement vers la bonne instance) :
   ```js
   // ~/.claude/agent-flow/hook.js:38
   cwd = JSON.parse(input).cwd
   ```
   Il compare `cwd` au `workspace` de chaque instance découverte (`hook.js:60-61`) — c'est du **routing**, pas de l'identité de session.

2. **Le relay/extension** utilise le `workspace` (dossier lancé) pour localiser
   `~/.claude/projects/<encoded-workspace>` (`relay.ts:270-293`, `session-watcher.ts:141-177`).
   L'encodage : `resolved.replace(/[^a-zA-Z0-9]/g, '-')` (`relay.ts:275`).

3. **Source de vérité par session** : le `cwd` est lu **dans le JSONL lui-même**
   (chaque transcript porte un champ `cwd`), utilisé aujourd'hui pour le test de containment :
   ```ts
   // session-watcher.ts:281-286
   if (typeof entry.cwd === 'string') {
     let cwd = entry.cwd
     try { cwd = fs.realpathSync(cwd) } catch {}
     const cwdFolded = foldPathCase(cwd)
     return cwdFolded === workspaceFolded || cwdFolded.startsWith(workspaceFolded + path.sep)
   }
   ```
   → **C'est ce `entry.cwd` qui est la clé de jointure** : il n'est aujourd'hui pas remonté dans `SessionInfo`, mais il est disponible ligne ~3 de chaque transcript.

### 1.c — Ce que stocke AO (store `~/.ao/data/ao.db`, SQLite)

Schéma `sessions` (extrait) :
```sql
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,      -- ex. "agent-flow-2", "intermitapp-1"
  project_id        TEXT NOT NULL,         -- ex. "agent-flow"
  kind              TEXT CHECK (kind IN ('worker','orchestrator')),
  harness           TEXT,                  -- 'claude-code' | 'codex' | ...
  activity_state    TEXT,                  -- active|idle|waiting_input|blocked|exited
  branch            TEXT,                  -- ex. "ao/agent-flow-2/root"
  workspace_path    TEXT,                  -- ← LE CHEMIN DE WORKTREE
  runtime_handle_id TEXT,                  -- == id AO ici
  agent_session_id  TEXT,                  -- ← VIDE partout (voir ci-dessous)
  display_name      TEXT, ...
);
```
Table `session_worktrees` (worktree_path, base_sha, …) existe mais **est vide** dans ce store
→ la localisation canonique du worktree est bien `sessions.workspace_path`.

Dump réel (sessions non terminées) :
```
agent-flow-2   worker       proj=agent-flow  agent_session_id=''  workspace_path='C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-2'
intermitapp-1  orchestrator proj=intermitapp agent_session_id=''  workspace_path='C:\Users\nicol\.ao\data\worktrees\intermitapp\orchestrator\intermitapp-orchestrator'
intermitapp-17 worker       proj=intermitapp agent_session_id=''  workspace_path='C:\Users\nicol\.ao\data\worktrees\intermitapp\intermitapp-17'
sync-1         orchestrator proj=sync         agent_session_id=''  workspace_path='C:\Users\nicol\.ao\data\worktrees\sync\orchestrator\sync-orchestrator'
```
`SELECT COUNT(*) FROM sessions WHERE agent_session_id != ''` → **0**.
Donc **AO ne stocke pas l'UUID de session Claude Code**.

### 1.d — Validation de la clé commune

Transcript Claude réel du worktree courant :
```
fichier   : b4803a5c-4e68-589d-a583-1e733b19fe0d.jsonl
sessionId : b4803a5c-4e68-589d-a583-1e733b19fe0d      ← SessionInfo.id du dashboard
cwd       : C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-2
```
Ligne AO correspondante :
```
id=agent-flow-2   workspace_path=C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-2
```
**`cwd` (transcript) === `workspace_path` (AO), à l'octet près.** ✅

> **Conclusion — clé de jointure retenue :**
> `normalize(entry.cwd)  ===  normalize(sessions.workspace_path)`
> avec `normalize` = `realpathSync` + case-fold Windows (exactement le `foldPathCase`
> déjà utilisé dans `session-watcher.ts`). L'hypothèse "worktree = cwd" est **exacte**.
>
> **Bonus (chemin direct, optionnel)** : le process de l'agent expose déjà en environnement
> `AO_SESSION_ID=agent-flow-2` et `AO_PROJECT_ID=agent-flow` (voir §4). Le hook (`hook.js`)
> s'exécute comme enfant du process Claude et **hérite donc de ces variables** — il pourrait
> les enrichir dans le payload pour offrir une jointure **explicite** sans dépendre du path.
> Mais le path reste la clé la plus robuste (marche même hors hook, via le scan des transcripts).

---

## 2) Parenté orchestrateur → workers dans AO

### Champ explicite ? — **Non.**

`ao session get` n'expose pas de parent :
```json
// ao session get agent-flow-2 --json
{ "session": { "id":"agent-flow-2","projectId":"agent-flow","kind":"worker",
  "harness":"claude-code","displayName":"recon-orch-view",
  "activity":{"state":"blocked",...},"isTerminated":false,... } }
// ao session get intermitapp-1 --json  →  "kind":"orchestrator", pas de parentId/spawnedBy
```
Dans la DB, la table `sessions` n'a **aucune** colonne `parent_id`/`orchestrator_id`/`spawned_by`.
La table `change_log` (event `session_created`) ne porte qu'un payload minimal :
```json
{ "id": "intermitapp-10", "activity": "idle", "isTerminated": false }
```
→ Aucune trace de parenté nulle part.

### Déduction de la parenté

La parenté est **implicite, par projet** :

1. **Grouper par `project_id`.**
2. Dans un projet, **l'orchestrateur = la session `kind='orchestrator'`** (généralement une seule ;
   listée par `ao orchestrator ls --json`). Les autres (`kind='worker'`) sont ses "workers".

Confirmé par `ao orchestrator ls --json` → `intermitapp-1`, `sync-1` (role `orchestrator`),
et `ao session ls --json` → tous les autres en `worker`.

Signaux secondaires (cohérents, mais ne pas s'y fier seuls) :
- Orchestrateur : `branch = ao/<project>-orchestrator`, `workspace_path = .../worktrees/<project>/orchestrator/<project>-orchestrator`.
- Worker : `branch = ao/<id>/root`, `workspace_path = .../worktrees/<project>/<id>`.

> **⚠️ Cas à gérer** : tous les projets n'ont PAS d'orchestrateur.
> Ici `agent-flow` et `launcher` n'ont que des workers (spawn direct, aucun `kind='orchestrator'`).
> La vue orchestrateur doit donc afficher soit un nœud "projet" fallback, soit regrouper ces
> workers sous un pseudo-nœud "(sans orchestrateur)" par projet.

---

## 3) Canal relay → daemon AO

### API HTTP/socket ?

- `ao status --json` → `{"state":"ready","pid":42628,"port":3001,"dataDir":"...\\.ao\\data",...}`.
  Conf dans `~/.ao/running.json` : `{ "pid":42628, "port":3001, "owner":"app" }`.
- Un serveur HTTP écoute bien sur `127.0.0.1:3001`, mais **tous les chemins REST évidents renvoient 404** :
  ```
  GET /        -> 404
  GET /health  -> 404
  GET /api     -> 404
  GET /status  -> 404
  GET /sessions-> 404
  ```
  → Vraisemblablement du **connect-RPC/gRPC** sur des routes typées (`/ao.v1.XxxService/Method`),
  **non documenté** et **fragile** à rétro-concevoir. À éviter.

### Le binaire `ao` est-il fiable ?

- Chemin résolu : `/c/Program Files/agent-orchestrator/resources/daemon/ao` (`ao.exe`, 24 Mo, présent).
- Ce répertoire est **dans le PATH** (`.../agent-orchestrator/resources/daemon`).
- `--json` fonctionne et est documenté (`skills/using-ao` : "Most read commands accept `--json`").
- **Latence mesurée** : `ao session ls --json` → **37 ms** (`real 0m0.037s`). Négligeable.

### Recommandation transport

> **Shell-out `ao ... --json` depuis le relay.** C'est le **contrat public** d'AO (stable,
> versionné, documenté), rapide (~37 ms), et découplé du schéma interne de la DB.
>
> - Commandes : `ao orchestrator ls --json` + `ao session ls --json` (une passe), puis
>   `ao session get <id> --json` seulement au clic si besoin de détail.
> - **Refresh par polling** toutes les **~2–3 s** (aligné sur `SCAN_INTERVAL_MS` du relay).
>   Pas de push AO disponible ; le polling léger suffit vu la latence.
> - Résolution du binaire : `ao` via PATH, fallback `path.join(AO_DATA_DIR, '..')` ou chemin
>   `resources/daemon/ao(.exe)`. Ne jamais `cd` ; passer `--json`.
>
> **Plan B (perf) — lecture directe `ao.db` en lecture seule** (`file:...?mode=ro`, gérer le WAL).
> Plus rapide encore, mais **couple au schéma interne** (risque de casse sur upgrade AO) et
> impose une dépendance SQLite. À ne considérer que si le shell-out devient un goulot (peu probable).

---

## 4) Portabilité — détecter "sous AO"

Variables d'environnement injectées dans le process agent (relevées dans CETTE session) :
```
AO_SESSION_ID=agent-flow-2
AO_PROJECT_ID=agent-flow
AO_DATA_DIR=C:\Users\nicol\.ao\data
AO_OWNER=app
CLAUDE_CODE_SESSION_ID=b4803a5c-4e68-589d-a583-1e733b19fe0d
PWD=/c/Users/nicol/.ao/data/worktrees/agent-flow/agent-flow-2
```

> **Détection recommandée (ET logique, du plus fort au plus faible) :**
> 1. **Daemon joignable** : `ao status --json` renvoie `state:"ready"` (ou `~/.ao/running.json` présent). → AO installé + up.
> 2. **Store présent** : `fs.existsSync(path.join(process.env.AO_DATA_DIR ?? '~/.ao/data', 'ao.db'))`.
> 3. **Workspace sous worktrees AO** : le `workspace`/`cwd` matche `**/.ao/**/worktrees/**` (case-fold).
>
> Activer la maille orchestrateur **seulement si (1 ou 2) est vrai**. En VS Code pur
> (aucun `~/.ao`, `ao status` échoue), la détection renvoie faux → la vue est masquée proprement,
> le dashboard reste identique à aujourd'hui.
>
> ⚠️ `AO_SESSION_ID` est fiable **côté agent**, mais le relay/extension peut tourner dans un
> autre process (app AO, `npx agent-flow-app`) qui n'hérite pas forcément de ces vars. Donc
> **ne pas** faire reposer la détection uniquement sur l'env : (1)+(2) sont les signaux robustes.

---

## Reco d'architecture

### Où brancher

Un nouveau module `scripts/ao-orchestrator-source.ts` (côté relay ; miroir extension possible
plus tard), branché dans `createRelay()` juste après le bloc `wantClaude` (`relay.ts:398-424`).

### Flux de données

1. **Détection AO** (§4) au démarrage du relay. Si faux → ne rien émettre (feature masquée).
2. **Poll** (2–3 s) : `ao orchestrator ls --json` + `ao session ls --json` → construire un arbre :
   ```
   Project(agent-flow)
     └─ [orchestrator?] intermitapp-1
          ├─ worker intermitapp-16  → workspace_path
          └─ worker intermitapp-17  → workspace_path
   ```
   (projets sans orchestrateur → nœud projet ou pseudo-nœud "sans orchestrateur").
3. **Jointure** : pour chaque session AO, `workspace_path` (normalisé) est la clé. Côté dashboard,
   remonter le `entry.cwd` par session dans `SessionInfo` (nouveau champ optionnel `cwd`) afin que
   le front puisse matcher une session live (UUID) à un nœud AO (id AO).
4. **Nouveau canal SSE** : un message `{ type: 'ao-topology', projects: [...] }` diffusé à la
   connexion + à chaque changement (diff). Réutilise `broadcast()` (`relay.ts:70`).

### Forme de données (proposition)

```ts
interface AoTopology {
  underAo: boolean
  projects: Array<{
    id: string
    orchestrator: AoNode | null           // kind='orchestrator'
    workers: AoNode[]                      // kind='worker'
  }>
}
interface AoNode {
  aoId: string                             // "agent-flow-2"
  kind: 'worker' | 'orchestrator'
  activityState: string                    // active|idle|blocked|...
  workspacePath: string                    // ← clé de jointure (normalisée)
  displayName?: string
  harness: string
  // résolu côté front : liveSessionId?: string (UUID Claude si un transcript live matche le cwd)
}
```
Le front rend la maille haute (orchestrateurs/projets) ; au clic sur un nœud, il filtre les
`SessionInfo` live dont `cwd === node.workspacePath` pour descendre sur le worker réel.

### Nouveau champ requis côté dashboard

Exposer `cwd` par session dans `SessionInfo` (aujourd'hui absent). Il est déjà lu dans le JSONL
(`session-watcher.ts:281`) ; il suffit de le capturer dans `WatchedSession` au `watchSession()` et
de le propager dans le `session-list`/`session-started`.

---

## Risques

| Risque | Détail | Mitigation |
|---|---|---|
| Schéma AO instable | Lecture directe DB couple au schéma interne | Passer par `ao --json` (contrat public) |
| RPC daemon non documenté | Port 3001 = connect-RPC 404 sur REST | Ne pas l'utiliser ; shell-out CLI |
| Projet sans orchestrateur | agent-flow/launcher = workers seuls | Nœud "projet"/"sans orchestrateur" |
| `cwd` ≠ `workspace_path` (symlinks/casse) | Windows: `c:` vs `C:`, realpath | `foldPathCase` + `realpathSync` (déjà en place) |
| Env AO absent hors agent | Relay/app peut ne pas hériter `AO_*` | Détection via `ao status` + `ao.db`, pas l'env seul |
| `ao` hors PATH | Env exotique | Fallback chemin `resources/daemon/ao(.exe)` |
| Multi-worktree même projet | Plusieurs workers, cwd distincts | Jointure par `workspace_path` exact (déjà unique) |

## Effort (par lot)

| Lot | Contenu | Effort |
|---|---|---|
| L1 — Détection AO | helper `isUnderAo()` (env + `ao status` + `ao.db`) | **XS** |
| L2 — Source topologie | module shell-out `ao orchestrator/session ls --json` + parse + arbre + poll | **S** |
| L3 — cwd dans SessionInfo | capturer `entry.cwd` dans `WatchedSession`, propager au front | **S** |
| L4 — Canal SSE `ao-topology` | broadcast + diff + rejeu à la connexion | **S** |
| L5 — UI maille orchestrateur | vue haute + drill-down clic → filtre sessions live par cwd | **M** |
| L6 — Robustesse/tests | projets sans orch, casse Windows, daemon down, tests | **M** |

Total ≈ **M** (cœur L1–L4 en **S** cumulé ; l'essentiel du coût est l'UI L5 + la robustesse L6).
