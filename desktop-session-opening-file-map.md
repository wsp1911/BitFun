# Desktop Session Opening Flow

This map describes the current desktop Web UI path for opening or creating a
conversation. The main sequence is:

`SessionsSection / WorkspaceItem -> openMainSession -> activateMainSession -> workspace activation -> FlowChatManager.switchChatSession -> historical hydrate -> FlowChatStore.switchSession -> modern-store projection -> scene commit -> SessionScene / ChatPane / ModernFlowChatContainer -> VirtualMessageList`

| File path | Summary | Line number range |
| --- | --- | --- |
| `src/web-ui/src/app/layout/AppLayout.tsx` | Starts the session-scene lifecycle during desktop layout initialization. | 38, 84 |
| `src/web-ui/src/app/components/NavPanel/sections/sessions/SessionsSection.tsx` | Handles an explicit session-row open: clears unread state, preloads historical sessions, resolves parent/child and workspace scope, then calls `openMainSession`. | 1054-1120 |
| `src/web-ui/src/app/components/NavPanel/sections/workspaces/WorkspaceItem.tsx` | Creates/reuses standard, ACP, or initialization sessions and opens them in the selected workspace. | 706-771 |
| `src/web-ui/src/flow_chat/services/sessionActivation.ts` | Central activation gate: rejects stale requests, serializes workspace activation, calls session switching, synchronizes the modern store, and opens the session scene. | 21-96 |
| `src/web-ui/src/flow_chat/services/FlowChatManager.ts` | Public manager facade that delegates session switching and historical preload to the session module. | 664-675 |
| `src/web-ui/src/flow_chat/services/flow-chat-manager/SessionModule.ts` | Owns historical-session preload/hydration, pending-load reuse, stale-request checks, and the switch ordering (hydrate-before-switch or switch-before-hydrate). | 121-332, 510-636 |
| `src/web-ui/src/flow_chat/store/FlowChatStore.ts` | Commits the selected session, updates `activeSessionId`/activity time, emits the session-switched event, and schedules partial-history completion. | 4329-4368 |
| `src/web-ui/src/flow_chat/services/storeSync.ts` | Projects the canonical FlowChat selection into the modern store without becoming another selection writer; also installs the shared auto-sync subscription. | 41-76 |
| `src/web-ui/src/flow_chat/store/modernFlowChatStore.ts` | Holds the rendered active-session projection and rebuilds virtual items when the canonical session changes. | 624-689 |
| `src/web-ui/src/app/services/sessionSceneLifecycle.ts` | Registers scene navigation callbacks, activates a session tab through `activateMainSession`, keeps scene selection synchronized, and reconciles workspace/session tabs. | 16-117 |
| `src/web-ui/src/app/stores/sceneStore.ts` | Guards scene navigation with pending requests, delegates session activation, then commits or updates the session scene tab. | 385-485 |
| `src/web-ui/src/app/services/sessionSceneTarget.ts` | Resolves the scene target and owning workspace identity used by session activation and tab reconciliation. | 1-80 |
| `src/web-ui/src/app/scenes/session/SessionScene.tsx` | Desktop session scene host; mounts the chat pane when the session scene is active. | 496-515 |
| `src/web-ui/src/app/scenes/session/ChatPane.tsx` | Mounts `ModernFlowChatContainer` and wires scene activity, file/workbench callbacks, and the chat input. | 186-220 |
| `src/web-ui/src/flow_chat/components/modern/ModernFlowChatContainer.tsx` | Reads the projected active session, owns history presentation/boundary requests, and renders the modern FlowChat surface. | 295-370, 1970-2023, 2641-2805 |
| `src/web-ui/src/flow_chat/components/modern/VirtualMessageList.tsx` | Renders the virtualized transcript and requests older/newer history at reader-driven boundaries, with opening/follow-output/latch guards. | 354-554, 2188-2338, 2340-2431 |
| `src/web-ui/src/flow_chat/utils/sessionWorkspace.ts` | Resolves session workspace IDs and project/execution paths used to route activation and history persistence. | 10-95 |

