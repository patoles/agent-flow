# R8 — Bug : le panneau « chat » disparaît en mode Split

> Fichier mémoire (diagnostic + cause racine + fix pas-à-pas). LECTURE SEULE effectuée ;
> aucune modification de code. Tous les chemins sont sous
> `C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1\`.

## 1. Cause racine (CONFIRMÉE)

Le mode Split **ne rend jamais** de `AgentChatPanel`. Deux faits combinés :

### (a) En mono-session, tout le bloc — dont le chat — est conditionné à `!showSplit`

`web/components/agent-visualizer/index.tsx`

```tsx
281  const showSplit = splitView && canSplit && paneSessions.length > 0
...
287        {showSplit && <SplitView sessions={paneSessions} bridge={bridge} />}
288
289        {/* Single-session mode (default / fallback) */}
290        {!showSplit && (
291        <>
...
362        {/* Chat panel (bottom-right, shown when agent selected) */}
363        <AgentChatPanel
364          visible={!!selectedAgent}
365          agentName={selectedAgent?.name ?? ''}
366          agentState={selectedAgent?.state ?? 'idle'}
367          conversation={selectedConversation}
368          runtime={selectedAgent?.runtime ?? sessionRuntime}
369          onClose={selection.clearAgent}
370        />
...
431        </>
432        )}
```

`<AgentChatPanel>` (ligne 363) — comme `<MessageFeedPanel>`, la carte détail, la timeline, etc.
— est **à l'intérieur** du fragment `{!showSplit && (<> … </>)}` (lignes 290→432). Dès que
`showSplit` passe à `true`, tout ce sous-arbre est démonté : le chat disparaît. C'est exactement
la piste du brief.

### (b) Le `SessionPane` ne rend PAS de chat

`web/components/agent-visualizer/session-pane.tsx` — le rendu d'un pane se limite au canvas, à
l'en-tête, et à la carte détail agent :

```tsx
 84    return (
 85      <div className="relative w-full h-full overflow-hidden" ... >
 93        <AgentCanvas ... />
109        {/* Pane header ... */}
124        {/* Agent detail card (absolute → positioned within this pane) */}
125        {selectedAgent && selection.selectedAgentWorldPos && (
126          <div {...stopPropagationHandlers}>
127            <AgentDetailCard agent={selectedAgent} onClose={selection.clearAgent} />
128          </div>
129        )}
130      </div>
131    )
```

Aucun import ni rendu de `AgentChatPanel`. De plus, le hook de simulation du pane ne récupère
même pas `conversations` :

```tsx
 53    const {
 54      frameRef, agents, toolCalls, discoveries,
 55      play, updateAgentPosition,
 56    } = useAgentSimulation({ ... })   // ← pas de `conversations`
```

**Conclusion** : le chat n'est rendu qu'en mono-session. En Split, il n'existe nulle part → il
« disparaît ». Ce n'est pas un bug de style/z-index, c'est une **fonctionnalité non portée** en
Phase 2.

### Préreqs déjà en place (bonne nouvelle pour le fix)

- `useAgentSimulation` **expose bien** `conversations` :
  `web/hooks/use-agent-simulation.ts:422` → `conversations: state.conversations`.
  Le pane n'a qu'à le destructurer.
- `AgentChatPanel` s'appuie sur `SlidingPanel`, positionné en **`position: absolute`** :
  `web/components/agent-visualizer/shared-ui.tsx:115` (`className="absolute …"`) avec
  `position={{ bottom: 64, right: 12 }}` (`chat-panel.tsx:34`). Donc il s'ancre au **plus proche
  ancêtre positionné**. Le conteneur du pane est `relative … overflow-hidden`
  (`session-pane.tsx:86`) : le chat se positionnera **dans le pane** et sera **clippé** par
  l'`overflow-hidden`. Aucun risque de fuite en viewport global.
- `stopPropagationHandlers` est déjà porté par `SlidingPanel` (via les props spread dans
  `chat-panel.tsx:37`), donc les clics du chat ne déclencheront pas le drag du canvas du pane.
- Constantes : `CARD.chat = { width: 300, maxHeight: 360, … }` (`lib/agent-types.ts:187`),
  `Z.chatPanel = 50` (`lib/agent-types.ts:198`).

## 2. Fix — comparaison des deux options

### Option (a) — Chat PAR panneau (rendu dans `SessionPane`) — ✅ RECOMMANDÉE

Chaque pane rend son propre `AgentChatPanel`, branché sur **son** agent sélectionné et **ses**
`conversations`. C'est le pendant exact de l'`AgentDetailCard` déjà présente dans le pane :
sélection + données restent **encapsulées** dans le pane, cohérent avec le design « self-contained »
documenté en tête de `session-pane.tsx`.

**Avantages**
- Isolation naturelle : chaque pane a déjà sa `useSelectionState` et sa simulation.
- Positionnement/clipping gratuits (ancêtre `relative overflow-hidden`, cf. §1).
- Multi-chat simultané (un par pane) — utile pour surveiller N sessions.
- Diff minimal, localisé à un seul fichier.

**Inconvénient** : N panels de chat à l'écran → un peu de charge visuelle (acceptable, chacun
n'apparaît que si un agent est sélectionné dans ce pane).

### Option (b) — Chat global unique piloté par le pane `focused`

Garder un seul `AgentChatPanel` au niveau `index.tsx`/`SplitView`, alimenté par la sélection et la
conversation du pane focalisé.

**Problème structurel** : la sélection (`useSelectionState`) **et** les `conversations` vivent
**à l'intérieur** de chaque `SessionPane` (état local, encapsulé). Pour alimenter un chat global il
faut **remonter cet état** (lifting state up) : soit un callback `onSelectionChange` +
`onConversationsChange` par pane, soit déplacer sélection/simulation dans le parent. Cela **casse
l'encapsulation** revendiquée du pane, ajoute du câblage inter-composants, et ne montre qu'**un
seul** chat à la fois. Positionnement global aussi à gérer (viewport, pas clippé par un pane).

**Verdict** : plus complexe, plus fragile, moins utile. **Option (a) retenue.**

## 3. Option (a) — pas-à-pas (fichiers/lignes exacts)

Un **seul fichier** à modifier : `web/components/agent-visualizer/session-pane.tsx`.

**Étape 1 — importer le chat** (près des imports existants, ~ligne 8) :
```tsx
import { AgentChatPanel } from './chat-panel'
```

**Étape 2 — récupérer `conversations` de la simulation** (bloc de destructuration lignes 53-56) :
```tsx
const {
  frameRef, agents, toolCalls, discoveries, conversations,   // ← + conversations
  play, updateAgentPosition,
} = useAgentSimulation({ ... })
```

**Étape 3 — dériver la conversation + le runtime de l'agent sélectionné** (près de la ligne 82,
après `const selectedAgent = …`) :
```tsx
const selectedConversation = selection.selectedAgentId
  ? (conversations.get(selection.selectedAgentId) ?? [])
  : []
```
Le `runtime` peut venir directement de `selectedAgent?.runtime` (fallback `'claude'`) ; inutile de
recopier le `sessionRuntime` global de `index.tsx` (chaque pane est mono-session).

**Étape 4 — rendre le chat dans le pane** (juste après le bloc `AgentDetailCard`, avant le `</div>`
de fermeture, ~ligne 129) :
```tsx
<AgentChatPanel
  visible={!!selectedAgent}
  agentName={selectedAgent?.name ?? ''}
  agentState={selectedAgent?.state ?? 'idle'}
  conversation={selectedConversation}
  runtime={selectedAgent?.runtime ?? 'claude'}
  onClose={selection.clearAgent}
/>
```

**Étape 5 (optionnel, cosmétique)** — en mono-session le chat est en `bottom: 64` pour dégager la
`ControlBar` ; dans un pane il n'y a pas de ControlBar. Deux choix :
- laisser tel quel (le décalage de 64px est inoffensif, juste un peu d'espace en bas), ou
- rendre l'offset configurable via une prop `position?` sur `AgentChatPanel` (ex. `bottom: 12` en
  split). Recommandation : **laisser tel quel** pour un premier fix minimal, ajuster ensuite si le
  rendu gêne.

## 4. Risques & pièges

- **Positionnement absolu vs viewport** : OK — `SlidingPanel` est `position: absolute`
  (`shared-ui.tsx:115`) et le pane est `relative overflow-hidden` (`session-pane.tsx:86`). Le chat
  reste **dans** le pane et est clippé. ⚠️ Ne jamais passer le chat en `position: fixed` : il
  s'ancrerait au viewport et réintroduirait le chevauchement inter-panes.
- **z-index inter-panes** : `Z.chatPanel = 50` est identique pour tous les panes, mais chaque pane
  a son propre contexte d'empilement clippé (`overflow-hidden`) → **pas de conflit** entre panes.
  À l'intérieur d'un pane, le chat (50) passe au-dessus du canvas ; vérifier qu'il ne masque pas
  l'en-tête si un jour l'en-tête devient interactif (aujourd'hui `pointer-events-none`, OK).
- **Audio / focus** : déjà géré. `useAudioEffects` n'est nourri que pour le pane `focused`
  (`session-pane.tsx:69`) ; le chat n'émet pas de son, aucun impact. La sélection agent (et donc
  l'affichage du chat) est **indépendante** du focus du pane — un pane non focalisé peut afficher son
  chat, ce qui est le comportement attendu (on peut sélectionner un agent dans n'importe quel pane).
- **`stopPropagationHandlers`** : déjà appliqués par `SlidingPanel` (spread dans `chat-panel.tsx:37`)
  → les interactions du chat ne déclenchent pas le drag/clic du canvas du pane ni le `onFocus`
  (`onMouseDownCapture` ligne 87 : le `stopPropagation` sur `onMouseDown` du chat empêche la
  capture parente de re-focaliser involontairement — comportement acceptable).
- **Perf** : `conversations` est déjà calculé par la simulation du pane, on ne fait que le lire.
  Aucun coût supplémentaire notable (`selectedConversation` = un `Map.get`).
- **Non-régression mono-session** : aucun changement dans `index.tsx` → le mode mono reste
  strictement identique.

## 5. Estimation d'effort

**XS** (≈ 15–30 min). Un seul fichier touché (`session-pane.tsx`), ~10 lignes ajoutées, aucune
nouvelle dépendance, aucun refactor d'état. Test manuel : activer Split, sélectionner un agent dans
un pane → le chat apparaît dans ce pane ; en sélectionner un dans un autre pane → chat indépendant.

---

## Synthèse

- **Cause racine confirmée** : en mode Split, aucun `AgentChatPanel` n'est rendu. En mono-session
  le chat est enfermé dans `{!showSplit && (…)}` (`index.tsx:290-432`, chat aux lignes 363-370),
  donc démonté dès que Split est actif ; et `SessionPane` ne rend que canvas + en-tête + carte
  détail (`session-pane.tsx:84-130`), jamais de chat. Fonctionnalité **non portée** en Phase 2,
  pas un bug de style.
- **Fix recommandé — option (a)** : rendre `AgentChatPanel` **dans** `SessionPane`, branché sur
  l'agent sélectionné du pane et ses `conversations`. C'est le pendant exact de l'`AgentDetailCard`
  déjà présente, cohérent avec le design « pane self-contained ».
- **Option (b)** (chat global piloté par le pane focalisé) écartée : impose de remonter
  sélection + conversations hors des panes (casse l'encapsulation), plus fragile, un seul chat.
- **Pré-requis déjà en place** : `useAgentSimulation` expose `conversations`
  (`use-agent-simulation.ts:422`) ; `SlidingPanel` est en `position: absolute`
  (`shared-ui.tsx:115`) et le pane est `relative overflow-hidden` → positionnement + clipping
  gratuits, pas de fuite viewport ; `stopPropagationHandlers` déjà portés.
- **Changement** : 1 fichier (`session-pane.tsx`), ~10 lignes (import + `conversations` +
  `selectedConversation` + `<AgentChatPanel>`). `index.tsx` inchangé → zéro régression mono-session.
- **Piège n°1** : garder le chat en `position: absolute` (jamais `fixed`) pour rester clippé dans
  le pane. **Effort : XS.**
