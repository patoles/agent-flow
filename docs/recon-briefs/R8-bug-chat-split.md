# Brief R8 — Bug : le panneau 'chat' disparaît en mode split

**Fichier de sortie** : `docs/recon-briefs/out/R8-bug-chat-split.md` (format « fichier mémoire » :
diagnostic + cause racine + fix recommandé pas-à-pas).

## Symptôme (rapporté)
Quand on active le mode **Split** (bouton « Split » / « diviser ») dans le dashboard, le panneau
**'chat'** n'apparaît plus. En mono-session il est bien là.

## Piste (à CONFIRMER par lecture du code, ne pas présumer)
Le mode split a été ajouté en Phase 2. Regarde en particulier :
- `web/components/agent-visualizer/index.tsx` — le mode mono-session (dont `<AgentChatPanel/>` et
  `<MessageFeedPanel/>`) est probablement enveloppé dans un `{!showSplit && (<> … </>)}`, donc **masqué**
  quand `showSplit` est vrai.
- `web/components/agent-visualizer/session-pane.tsx` — le panneau de split ne rend **que** la carte
  détail agent (`AgentDetailCard`), **pas** de chat.
- `web/components/agent-visualizer/chat-panel.tsx` (`AgentChatPanel`) — le composant chat + ses props
  (visible, conversation, agentName, agentState, runtime).
- `web/hooks/use-selection-state.ts` (agent sélectionné) et `use-agent-simulation.ts` (`conversations`
  par session) — pour savoir d'où vient la conversation à afficher.

## Ce qu'on attend de toi
1. **Confirmer la cause racine** avec extraits de code + numéros de ligne (chemins absolus sous
   `C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1\`). LECTURE SEULE, ne modifie pas le code.
2. **Proposer le fix** — compare 2 approches et recommande la plus simple/robuste :
   - (a) **chat par panneau** : rendre `AgentChatPanel` dans `SessionPane`, branché sur l'agent
     sélectionné de CE panneau et les `conversations` de SA simulation (contenu dans le pane, positionné
     en absolu comme la carte détail) ;
   - (b) **chat global piloté par le panneau focalisé** : garder un seul `AgentChatPanel`, alimenté par
     la sélection/conversation du pane `focused`.
   Donne pour l'option retenue les **fichiers/lignes exacts à modifier** et les pièges (positionnement
   absolu vs viewport, z-index, audio/focus déjà géré, `stopPropagationHandlers`).
3. **Livrable** : écris un fichier mémoire markdown dans `docs/recon-briefs/out/R8-bug-chat-split.md`
   (cause + fix pas-à-pas + risques), prêt à guider l'implémentation. Termine par une synthèse courte.

## Contexte projet
Lis d'abord `C:\Users\nicol\.ao\data\worktrees\agent-flow\agent-flow-1\docs\recon-briefs\00-projet-recap.md`
(architecture, flux de données, état Phases 1/2, chemins clés).
