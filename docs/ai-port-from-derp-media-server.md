# AI porting plan: derp-media-server → derp-workspace

Source repo (reference only): `c:\Users\crab\derp-media-server`  
Target repo: `c:\Users\crab\derp-workspace` (compositor + CEF shell, Solid, shared memory, shell wire)

## Hard exclusions

- **Music / standalone audio player**: do not port `src/media/AudioPlayer.tsx`, `src/media/MainMediaPlayers.tsx` audio bar behavior, `src/workspace/WorkspaceTaskbarAudio.tsx`, `tests/e2e/audio-player.spec.ts`, `tests/e2e/share-audio-api.spec.ts`, or server helpers whose only consumer is that flow (`server/lib/audio-helpers.ts` if unused elsewhere).
- **Optional later**: “audio-only mode” for *video* URLs (`audioOnly` query / `video-audio-mode-switch.spec.ts`) — only if video viewer needs parity; not the music player.

## Architectural mapping (every feature must land here)

| Media server concept | derp-workspace home |
| --- | --- |
| Browser owns layout; local `solid-js/store` + queries | Compositor owns windows, screens, workspace, tiling. Shell **renders** from snapshot; **mutates** via `shellWireSend('workspace_mutation', …)` and related bridge APIs only. |
| Fastify `/api/*`, SSE, cookies, shares | No direct port: replace with **compositor/session APIs**, **shell HTTP bridge** (`shell/src/features/bridge/*`), persistence in compositor session state. Network shares/auth are **new product surface** if still wanted. |
| Workspace panes (browser, viewers) as DOM in one page | **Per-window** hosted apps (`shellHostedWindowContent`, `shellHostedAppsRegistry`) + **native/X11** windows with same taskbar/workspace rules. |
| Single viewport taskbar | **Per-output taskbars** (`taskbars[]`, monitor name) — every UX change must define which output it applies to and how focus moves across outputs. |

## Global constraints for every task (from `AGENTS.md`)

- Shell: **no duplicated/edited workspace cache** — commands only.
- Shell UI: **inline Tailwind** in shell TSX; no new shell-wide CSS classes.
- Tests: **remote** `./scripts/remote-verify.sh`, `./scripts/e2e-remote.sh`; compositor/native/e2e harness changes need **remote e2e** + artifacts under `.artifacts/e2e`. No sleeps/timeouts/retries in tests.
- After substantive changes: `./scripts/remote-update-and-restart.sh`; debug via `./scripts/fetch-logs.sh` (temporary `warn` logs, remove after).

---

## Phase 0 — Inventory and parity matrix (complete)

- [x] Walk `derp-media-server/src/` and `tests/e2e/*.spec.ts`; tag each file: **port**, **skip (music)**, **defer (network/share/auth)**, **rewrite (compositor)**.
- [x] For each **port** item, note target: `compositor/`, `shell/src/apps/*`, `shell/src/features/*`, or new bridge endpoint.
- [x] List media-server **e2e spec →** proposed `shell/e2e/specs/*.spec.ts` (or compositor `e2e`) name; mark specs that require multi-user or HTTP server as **blocked** until backend story exists.

Tag legend: **port** = ship in workspace with local/bridge semantics · **skip** = music exclusion · **defer** = needs network/share/auth/SSE/API product · **rewrite** = same UX but compositor-owned state and shell wire (often touches `compositor/src/session/*`, `shell/src/features/workspace/*`, `shell/src/features/bridge/*`).

### `derp-media-server/src/` (82 TS/TSX files)

| Path | Tag | Primary target |
| --- | --- | --- |
| `App.tsx` | defer | Login/share routing; shell bootstrap is `shell/src/index.tsx` |
| `FileBrowser.tsx` | port | `shell/src/apps/file-browser/FileBrowserWindow.tsx` + bridge |
| `GlobalForbiddenToast.tsx` | defer | API 403 / share forbidden; no Fastify equivalent yet |
| `ShareFileViewer.tsx` | defer | Share token media; later guest viewer or drop |
| `ShareFolderBrowser.tsx` | defer | Share-scoped listing; patterns → Phase 1 when share exists |
| `SharePasscodeGate.tsx` | defer | Share auth |
| `ShareRoute.tsx` | defer | Share router |
| `ShareWorkspacePage.tsx` | defer | Share workspace |
| `SolidThemeSync.tsx` | port | `shell/src/apps/settings/*` + theme DOM hooks |
| `ThemeSwitcher.tsx` | port | `SettingsAppearancePage` / shell menus |
| `ThemeSwitcherMenuContent.tsx` | port | same |
| `WorkspacePage.tsx` | rewrite | `shell/src/host/*` + compositor session snapshot consumers |
| `browser-history.ts` | rewrite | Minimal URL/deep-link story or session-only (see `url-state` e2e) |
| `file-browser/BreadcrumbContextMenu.tsx` | port | `shell/src/apps/file-browser/*` |
| `file-browser/Breadcrumbs.tsx` | port | same |
| `file-browser/CreateFileDialog.tsx` | port | same |
| `file-browser/CreateFolderDialog.tsx` | port | same |
| `file-browser/DeleteFileDialog.tsx` | port | same |
| `file-browser/DirectoryListingFeedback.tsx` | port | same |
| `file-browser/FileBrowserModalLayer.tsx` | port | `shell/src/host/*` modal stacking |
| `file-browser/FileRowContextMenu.tsx` | port | `FileBrowserContextMenu.tsx` |
| `file-browser/FloatingContextMenu.tsx` | port | `shell/src/host/ShellContextMenuLayer.tsx` patterns |
| `file-browser/IconEditorDialog.tsx` | port | same |
| `file-browser/KbDashboard.tsx` | defer | KB dashboard |
| `file-browser/KbInlineCreateFooter.tsx` | defer | KB create |
| `file-browser/KbSearchResults.tsx` | defer | KB search UI |
| `file-browser/MoveToDialog.tsx` | port | file browser + compositor FS ops |
| `file-browser/PasteDialog.tsx` | port | same |
| `file-browser/RenameDialog.tsx` | port | same |
| `file-browser/ShareDialog.tsx` | defer | Share links |
| `file-browser/UploadMenu.tsx` | port | file browser + bridge upload |
| `file-browser/UploadToastStack.tsx` | port | same |
| `file-browser/ViewModeToggle.tsx` | port | file browser prefs |
| `file-browser/modal-overlay-scope.ts` | port | shell modal scope |
| `file-browser/navigate-folder.ts` | port | `fileBrowserState` / bridge |
| `file-browser/types.ts` | port | `fileBrowserState.ts` types |
| `file-browser/use-file-row-context-menu.ts` | port | context menu hooks |
| `file-browser/use-inline-mode-input-focus.ts` | port | UX utility |
| `file-browser/use-kb-search-hotkey.ts` | defer | KB hotkey |
| `kb-chat/KbChatFooter.tsx` | defer | Phase 4 |
| `kb-chat/KbChatHistoryList.tsx` | defer | Phase 4 |
| `kb-chat/KbChatMessage.tsx` | defer | Phase 4 |
| `kb-chat/KbChatPane.tsx` | defer | Phase 4 |
| `kb-chat/KbChatWindowPane.tsx` | defer | Phase 4 |
| `lib/build-media-url.ts` | defer | Server media URLs; replace with local file URLs / bridge |
| `lib/long-press-context-menu.ts` | port | shell input helpers |
| `lib/share-text-viewer-settings.ts` | defer | Share viewer settings |
| `lib/solid-available-icons.tsx` | port | shell if icon picker needed |
| `lib/solid-store-sync.ts` | port | patterns only; avoid duplicating compositor state in shell |
| `lib/use-deferred-loading.ts` | port | shell utilities |
| `lib/use-file-icon.tsx` | port | file browser / desktop icons |
| `media/AudioPlayer.tsx` | skip | excluded |
| `media/ImageViewerDialog.tsx` | port | `shell/src/apps/image-viewer/*` |
| `media/MainMediaPlayers.tsx` | skip | audio bar excluded; video entrypoints use `VideoPlayer` / `video-viewer` |
| `media/MarkdownPane.tsx` | port | `shell/src/apps/text-editor/MarkdownPane.tsx` |
| `media/PdfViewerDialog.tsx` | port | new `shell/src/apps/pdf-viewer/*` + open pipeline |
| `media/TextViewerDialog.tsx` | port | `text-editor` hosted window |
| `media/UnsupportedFileViewerDialog.tsx` | port | open-with / error surface in compositor or shell |
| `media/VideoPlayer.tsx` | port | `shell/src/apps/video-viewer/*` |
| `media/text-viewer-markdown.ts` | port | `textEditorCore.ts` / `textViewerMarkdown.ts` |
| `workspace/WorkspaceBrowserModalLayer.tsx` | rewrite | `shell/src/host/*` + compositor z-order |
| `workspace/WorkspaceBrowserPane.tsx` | rewrite | file browser as backed window |
| `workspace/WorkspaceLayoutHoverPreview.tsx` | rewrite | `features/workspace` + compositor snap |
| `workspace/WorkspaceNamedLayoutMenu.tsx` | rewrite | compositor layout presets + shell UI |
| `workspace/WorkspaceSnapAssistBar.tsx` | rewrite | align `snap-assist.spec.ts` / `features/tiling` |
| `workspace/WorkspaceSnapAssistMasterGrid.tsx` | rewrite | compositor + `shell/e2e/specs/snap-assist.spec.ts` |
| `workspace/WorkspaceTabStrip.tsx` | rewrite | `features/workspace` + tab context menus |
| `workspace/WorkspaceTaskbarAudio.tsx` | skip | excluded |
| `workspace/WorkspaceTaskbarRows.tsx` | rewrite | `shell/src/features/taskbar/Taskbar.tsx` (per-output) |
| `workspace/WorkspaceTaskbarSettings.tsx` | port | shell chrome / settings launcher |
| `workspace/WorkspaceTilingPicker.tsx` | rewrite | compositor tiling API + shell |
| `workspace/WorkspaceViewerPane.tsx` | rewrite | per-window hosted content registry |
| `workspace/WorkspaceWindowChrome.tsx` | rewrite | `shell/src/host/*` window chrome |
| `workspace/merge-target.ts` | rewrite | `tabGroupOps.ts` + compositor mutations |
| `workspace/tab-drop-hit.ts` | rewrite | compositor hit testing / shell drag |
| `workspace/tab-group-ops.ts` | rewrite | `shell/src/features/workspace/tabGroupOps.ts` + compositor |
| `workspace/workspace-browser-pane-types.ts` | port | shell types near workspace |
| `workspace/workspace-page-persistence.ts` | rewrite | `sessionPersistenceBridge` + `compositor/src/session/*` |
| `workspace/workspace-browser-pane-paths.ts` | port | path helpers → bridge FS |
| `workspace/snap-preview.ts` | rewrite | compositor overlay |
| `workspace/workspace-snap-resize-handles.ts` | rewrite | compositor resize grabs |
| `workspace/workspace-page/WorkspacePageCanvas.tsx` | rewrite | shell surfaces + multimonitor geometry |
| `workspace/workspace-page/WorkspacePageTaskbar.tsx` | rewrite | `Taskbar.tsx` per monitor |
| `workspace/workspace-page/create-workspace-snap-drag-model.ts` | rewrite | compositor drag + shell preview |
| `workspace/workspace-page/use-workspace-page-document-chrome.ts` | rewrite | per-window chrome state from snapshot |
| `workspace/workspace-page/use-workspace-page-layout-baseline.ts` | rewrite | compositor layout baseline |
| `workspace/workspace-page/use-workspace-page-local-persistence.ts` | rewrite | session store compositor-side |
| `workspace/workspace-page/use-workspace-page-server-data.ts` | defer | TanStack queries to `/api`; replace with bridge |
| `workspace/workspace-page/workspace-page-types.ts` | rewrite | align with `DerpWindow` / session types |
| `index.tsx` | rewrite | `shell/src/index.tsx` |

**`src/lib/` (streams and URL state)** — not duplicated in rows above: `use-admin-events-stream.ts`, `sse-shared-worker.ts`, `sse-shared-worker-client.ts` → **defer** (SSE). `use-share-file-watcher.ts`, `use-view-stats.ts` → **defer** (share/stats API). `url-state-actions.ts` → **defer** / **rewrite** with compositor session deep links. `use-dynamic-favicon.ts` → **port** optional polish.

### `derp-media-server/lib/` (66 TS files) — grouped

**skip (music):** `use-media-player.ts`, `workspace-audio-store.ts`

**defer (network/share/auth/SSE/API):** `api.ts`, `auth.ts`, `share-access.ts`, `shares.ts`, `forbidden-notify.ts`, `use-share-file-watcher.ts`, `navigate-share-classic-from-workspace.ts`, `sse-reconnect.ts`, `sse-shared-worker-client.ts`, `sse-shared-worker.ts`, `use-admin-events-stream.ts`, `file-change-emitter.ts` (tied to SSE), `use-view-stats.ts`, `query-keys.ts` (server query shapes), `config.ts` (server config), `mcp-ai-tool-key.ts`, `kb-chats.ts`, `knowledge-base.ts`, `workspace-kb-chat-title.ts`, `kb-chat-fs-paths.ts` (until KB host exists)

**rewrite (compositor / session / layout):** `use-workspace.ts`, `workspace-bootstrap.ts`, `workspace-session-store.ts`, `workspace-file-open-target.ts`, `workspace-file-open-target-picker.ts`, `workspace-layout-presets.ts`, `workspace-layout-presets-schema.ts`, `workspace-layout-presets-types.ts`, `workspace-layout-preview.ts`, `workspace-geometry.ts`, `layout-viewport.ts`, `workspace-snap-live.ts`, `workspace-snap-pick.ts`, `workspace-preferred-snap-store.ts`, `use-snap-zones.ts`, `workspace-assist-grid.ts`, `floating-layer-registry.ts` / `floating-layer-mount.ts` / `floating-z-index.ts` (map to shell host layers with compositor ordering rules), `url-state-actions.ts` (session or defer)

**port (shell apps, bridge, pure helpers):** `workspace-taskbar-pins.ts`, `workspace-browser-dir-title.ts`, `workspace-tab-icon-colors.ts`, `workspace-video-intrinsics-preload.ts`, `use-video-playback-time.ts`, `use-video-player-position.ts`, `workspace-file-open-target-anchor.test.ts` → move logic into compositor tests + `shell/src/**/*.test.ts`, `download-urls.ts` (local save), `collect-dropped-upload-files.ts`, `extract-paste-data.ts`, `paste-data.ts`, `should-offer-paste-as-new-file.ts`, `pasted-kb-image.ts`, `handle-kb-image-paste.ts` (markdown paste without KB server → port to text-editor), `resolve-markdown-image-url.ts` → already mirrored `shell/.../resolveMarkdownImageReadUrl.ts`, `file-drag-data.ts`, `file-system.ts` (concepts → `fileBrowserBridge`), `media-utils.ts`, `breadcrumb-floating-store.ts`, `prefetch-folder-hover.ts`, `enable-fine-pointer-drag.ts`, `clamp-fixed-menu.ts`, `browser-view-mode-store.ts`, `client-store-utils.ts`, `constants.ts`, `types.ts`, `utils.ts`, `mutex.ts`, `navigation-session.ts`, `source-context.ts`, `theme-store.ts`, `theme-dom.ts`, `dynamic-favicon-core.ts`, `use-dynamic-favicon.ts`, `use-settings.ts` → `shell/src/apps/settings/userSettings.ts`, `extract-paste-data.test.ts` etc. migrate with ported modules

### `derp-media-server/server/` (21 files)

| Path | Tag | Notes |
| --- | --- | --- |
| `auth-middleware.ts` | defer | Local compositor has no cookie session |
| `html.ts` | defer | SSR dehydration; shell is CEF bundle |
| `index.ts` | defer | Fastify root |
| `kb-context.ts` | defer | Phase 4 |
| `kb-chat-fs-tools.ts` | defer | Phase 4 |
| `mcp-kb-chat-tools.ts` | defer | Phase 4 |
| `routes/api/auth.ts` | defer | |
| `routes/api/files.ts` | defer | Replace with `fileBrowserBridge` / compositor |
| `routes/api/kb.ts` | defer | |
| `routes/api/kb-chat.ts` | defer | |
| `routes/api/settings.ts` | defer | Map concepts to `userSettings` + compositor gsettings |
| `routes/api/shareAccess.ts` | defer | |
| `routes/api/shares.ts` | defer | |
| `routes/api/stats.ts` | defer | |
| `routes/download.ts` | defer | Local download via bridge |
| `routes/media.ts` | defer | |
| `routes/shareMedia.ts` | defer | |
| `routes/sse.ts` | defer | Local FS notifications TBD in compositor |
| `routes/thumbnail.ts` | defer | Optional local thumbnail service |
| `routes/upload.ts` | defer | Bridge upload |
| `lib/audio-helpers.ts` | skip | music |

### `tests/e2e/*.spec.ts` → `shell/e2e/specs` (or compositor `e2e`)

| Media-server spec | Tag | Proposed workspace spec | Blocked |
| --- | --- | --- | --- |
| `audio-player.spec.ts` | skip | — | — |
| `share-audio-api.spec.ts` | skip | — | — |
| `login.spec.ts` | defer | — | needs auth product |
| `passcode-shares.spec.ts` | defer | `share-passcode.spec.ts` (future) | share server |
| `share-browser-parity.spec.ts` | defer | — | share |
| `share-security.spec.ts` | defer | — | share |
| `share-viewers.spec.ts` | defer | — | share |
| `share-workspace.spec.ts` | defer | — | share |
| `shares-manage.spec.ts` | defer | — | share |
| `shares-use.spec.ts` | defer | — | share |
| `sse-live-updates.spec.ts` | defer | `fs-live-updates.spec.ts` (future) | SSE / inotify story |
| `workspace-share-from-browser.spec.ts` | defer | — | share |
| `knowledge-base.spec.ts` | defer | `knowledge-base.spec.ts` (future) | LLM + tools host |
| `breadcrumbs-adaptive.spec.ts` | port | `file-browser-breadcrumbs.spec.ts` | no |
| `download.spec.ts` | port | `file-browser-download.spec.ts` | no |
| `drag-drop.spec.ts` | port | `file-browser-drag-drop.spec.ts` | no |
| `editable-folders.spec.ts` | port | `file-browser-editable-folders.spec.ts` | no |
| `file-browser-directory-ux.spec.ts` | port | `file-browser-directory-ux.spec.ts` | no |
| `file-browser-misc.spec.ts` | port | extend `file-browser.spec.ts` | no |
| `navigation.spec.ts` | port | `shell-navigation.spec.ts` or extend `file-browser.spec.ts` | no |
| `upload.spec.ts` | port | `file-browser-upload.spec.ts` | no |
| `image-viewer.spec.ts` | port | `image-viewer.spec.ts` | no |
| `pdf-viewer.spec.ts` | port | `pdf-viewer.spec.ts` | no |
| `text-editor.spec.ts` | port | extend `shell/e2e/specs/text-editor.spec.ts` | no |
| `video-player.spec.ts` | port | `video-viewer.spec.ts` | no |
| `video-audio-mode-switch.spec.ts` | optional | `video-viewer-audio-mode.spec.ts` | product call |
| `workspace-controls.spec.ts` | rewrite | `workspace-controls.spec.ts` | no |
| `workspace-cross-dnd.spec.ts` | rewrite | `workspace-cross-dnd.spec.ts` (+ helpers in `shell/e2e/lib/runtime.ts`) | no |
| `workspace-file-open-target.spec.ts` | rewrite | `workspace-file-open-target.spec.ts` | no |
| `workspace-layout-chrome.spec.ts` | rewrite | extend `shell-chrome.spec.ts` / `shell-chrome-session.spec.ts` | no |
| `workspace-layout-sessions.spec.ts` | rewrite | extend `restart-persistence.spec.ts` | no |
| `workspace-layout-snap-resize.spec.ts` | rewrite | extend `snap-assist.spec.ts` | no |
| `workspace-media-layout.spec.ts` | port | `workspace-media-layout.spec.ts` | strip audio assertions |
| `workspace-named-layouts.spec.ts` | rewrite | `workspace-named-layouts.spec.ts` | no |
| `workspace-split-view.spec.ts` | rewrite | extend `tab-groups.spec.ts` or new spec | no |
| `workspace-taskbar-chrome.spec.ts` | rewrite | extend `shell-chrome.spec.ts` | no |
| `workspace-taskbar-pins.spec.ts` | rewrite | `workspace-taskbar-pins.spec.ts` | no |
| `workspace-viewers.spec.ts` | port | `workspace-viewers.spec.ts` | no |
| `url-state.spec.ts` | defer | `session-deep-links.spec.ts` (future) | URL routing product |

**Non-spec e2e helpers**

| Path | Tag | Target |
| --- | --- | --- |
| `tests/e2e/workspace-e2e-auth.ts` | defer | fixture auth for share specs |
| `tests/e2e/workspace-cross-dnd-helpers.ts` | port | adapt into `shell/e2e/lib/runtime.ts` |
| `tests/e2e/workspace-layout-helpers.ts` | port | adapt into `shell/e2e/lib/runtime.ts` |

### `tests/unit/` (25 files)

| Path | Tag | Target |
| --- | --- | --- |
| `share-path.test.ts` | defer | share path rules |
| `knowledge-base.test.ts` | defer | KB |
| `kb-chat-fs-paths.test.ts` | defer | KB FS paths |
| `mcp-ai-tool-key.test.ts` | defer | MCP |
| `mcp-config-parse.test.ts` | defer | MCP |
| `download-urls.test.ts` | port | shell or bridge URL builder tests |
| `extract-paste-data.test.ts` | port | `shell/src/**/*.test.ts` |
| `file-drag-data.test.ts` | port | same |
| `pasted-kb-image.test.ts` | port/defer | port if only markdown paste; defer if KB upload |
| `resolve-markdown-image-url.test.ts` | port | align `resolveMarkdownImageReadUrl.test.ts` |
| `workspace-bootstrap.test.ts` | rewrite | compositor session bootstrap tests (Rust or TS pure) |
| `workspace-canvas-scale.test.ts` | rewrite | compositor/shell scale |
| `workspace-default-browser-title.test.ts` | rewrite | window title rules in compositor |
| `workspace-file-open-target-anchor.test.ts` | rewrite | compositor open-target |
| `workspace-layout-preview.test.ts` | rewrite | snap preview |
| `workspace-layout-reconcile.test.ts` | rewrite | layout reconcile compositor |
| `workspace-merge-target.test.ts` | rewrite | `tabGroupOps` / compositor |
| `workspace-resize.test.ts` | rewrite | compositor resize |
| `workspace-snap-zones.test.ts` | rewrite | compositor zones |
| `workspace-split-view.test.ts` | rewrite | compositor split |
| `workspace-tab-drop-hit.test.ts` | rewrite | compositor hit test |
| `workspace-tab-group-visibility.test.ts` | rewrite | compositor visibility |
| `workspace-tab-pin.test.ts` | rewrite | compositor pins |
| `workspace-taskbar-pins.test.ts` | rewrite | compositor + shell taskbar |
| `test-dom-globals.ts` | port | shell unit test harness if needed |

### Existing `shell/e2e/specs` overlap (for gap analysis)

`snap-assist.spec.ts`, `tab-groups.spec.ts`, `file-browser.spec.ts`, `text-editor.spec.ts`, `native-windows.spec.ts`, `x11-windows.spec.ts`, `launcher-multimonitor.spec.ts`, `shell-chrome.spec.ts`, `shell-chrome-session.spec.ts`, `restart-persistence.spec.ts`, `compositor-snapshot.spec.ts`, `artifacts.spec.ts`, `perf-smoke.spec.ts`, `restart-input.spec.ts` — extend these when media-server specs overlap instead of duplicating names.

## Phase 1 — File browser (local FS, no share server)

Reference: `src/FileBrowser.tsx`, `src/file-browser/*`, `src/ShareFolderBrowser.tsx` (UI patterns only if share deferred), e2e: `file-browser-*.spec.ts`, `drag-drop`, `upload`, `download`, `breadcrumbs-adaptive`, `editable-folders`, `navigation`.

- [ ] Dialog parity: create/rename/delete/move/paste/share UI from media-server → shell file browser only where **local** semantics match; strip or gate **share-token** flows until share product exists.
- [ ] Context menus, breadcrumbs, directory feedback, upload toasts, keyboard search hooks — port UX; wire to **compositor file browser / bridge** (`fileBrowserBridge`, CEF file APIs) instead of `/api/files`.
- [ ] **Multi-monitor**: open-location and “default monitor” for new file-browser windows; drag between outputs if compositor supports cross-output DnD (align with `workspace-cross-dnd` intent).
- [ ] **Native windows**: opening paths in native apps vs hosted apps — follow `desktopApplicationsState` / launcher rules; e2e coverage alongside JS windows.
- [ ] Migrate or rewrite e2e: `shell/e2e/specs/file-browser.spec.ts` extension + new specs per media-server file, using **real pointer** APIs from `shell/e2e/lib/runtime.ts`.

## Phase 2 — Workspace chrome and layout (tabs, tiling, snap)

Reference: `src/workspace/*`, `src/WorkspacePage.tsx`, `lib/use-workspace.ts`, e2e: `workspace-*`, `workspace-layout-*`, `workspace-controls`, `snap-assist` (media-server) vs existing `shell/e2e/specs/snap-assist.spec.ts`.

- [ ] Tab strip / merge targets / `tab-group-ops` behaviors: diff against `shell/src/features/workspace/*` and compositor `workspace_model` mutations; port **missing** gestures only via compositor commands.
- [ ] Named layouts, layout hover preview, tiling picker, snap-assist master grid — ensure **per-screen** geometry (work area minus taskbar per output).
- [ ] Split view, layout sessions, persistence: align with `sessionPersistenceBridge` / compositor JSON session — no shell-local layout store.
- [ ] **Cross-DnD** between groups/monitors: mirror `workspace-cross-dnd.spec.ts` + helpers; verify native window IDs participate where supported (`native-windows.spec.ts` patterns).
- [ ] Taskbar rows/pins/chrome: align `WorkspaceTaskbarRows`-style UX with `Taskbar.tsx` per-monitor data; pins may map to **desktop app usage** / favorites already in shell — merge product behavior, do not fork state.

## Phase 3 — Viewers and editors (no music)

Reference: `src/media/VideoPlayer.tsx`, `src/media/MarkdownPane.tsx`, `TextViewerDialog`, `ShareFileViewer`, e2e: `video-player`, `image-viewer`, `text-editor`, `pdf-viewer`, `workspace-viewers`, `workspace-media-layout` (minus audio bar).

- [ ] **Video**: port missing controls/keyboard from `VideoPlayer` into `shell/src/apps/video-viewer/*`; fullscreen and focus must respect **native vs hosted** (`shell_flags`).
- [ ] **Image**: parity in `image-viewer` (zoom, keyboard, chrome).
- [ ] **PDF**: if not present in shell, add hosted app + compositor open pipeline; e2e with existing pdf fixture paths in `shell/e2e`.
- [ ] **Text / markdown**: align `text-editor` with media-server `MarkdownPane` / turndown flows where still applicable; filesystem reads/writes via bridge, not `/api`.
- [ ] Open-file routing: `workspace-file-open-target.spec.ts` behavior (correct target window/group) via compositor **open** commands.

## Phase 4 — Knowledge base + chat (largest server coupling)

Reference: `src/kb-chat/*`, `server/routes/api/kb*.ts`, `server/kb-chat-fs-tools.ts`, `server/mcp-kb-chat-tools.ts`, e2e: `knowledge-base.spec.ts`.

- [ ] Decide runtime: **embedded service in compositor**, **local sidecar process**, or **defer**. Media-server deps (`ai`, `@ai-sdk/*`, MCP) do not belong in shell alone.
- [ ] If shipped: filesystem tools must use **same permission model** as file browser (user-visible paths, no extra shell cache).
- [ ] UI port: `KbChatPane` → hosted window app; streaming UX must not block compositor thread.
- [ ] Tests: new remote e2e behind feature flag or fixture mock server if no network in CI.

## Phase 5 — Sharing, auth, SSE (optional product track)

Reference: `ShareRoute`, `ShareWorkspacePage`, `SharePasscodeGate`, `server/routes/api/shares.ts`, `shareAccess.ts`, `sse.ts`, e2e: `share-*`, `passcode-shares`, `shares-*`, `sse-live-updates`, `login.spec.ts`.

- [ ] Treat as **separate milestone**: compositor is local-first; port only after clear security model (tokens, CEF cookie isolation, TLS).
- [ ] Until then: document which e2e specs are **not applicable** vs **rewrite** as local “guest session” or export/import.

## Phase 6 — Theming, settings, polish

Reference: `ThemeSwitcher*`, `SolidThemeSync`, `server/routes/api/settings.ts`, media-server `config.jsonc`.

- [ ] Map to `shell/src/apps/settings/*` and compositor **gdm_settings** / appearance background pipeline already in workspace.
- [ ] URL state (`url-state.spec.ts`): replace with compositor session + optional shell router only if product needs deep links.

## Phase 7 — Test migration closure

- [ ] For each migrated feature, **one** remote e2e spec (sequential tests, no parallel runs per `AGENTS.md`).
- [ ] Copy **behaviors** from Playwright specs, not harness assumptions (no web-only `page.goto` to localhost unless workspace runs equivalent HTTP test stub).
- [ ] Run full `./scripts/e2e-remote.sh` before declaring milestone done.

## Suggested execution order for agents

1. ~~Phase 0 matrix~~ (done in this doc)  
2. Phases 1–3 (local UX, compositor-aligned)  
3. Phase 6 small parity wins  
4. Phase 4 or 5 based on product priority  
5. Phase 7 continuous

## Quick reference: media-server e2e files

Full mapping and **blocked** flags are in the Phase 0 **tests/e2e** table above. Summary: **skip** `audio-player`, `share-audio-api` · **defer** login, all `share-*`, `passcode-shares`, `shares-*`, `sse-live-updates`, `workspace-share-from-browser`, `knowledge-base`, `url-state` · **optional** `video-audio-mode-switch` · **port/rewrite** everything else per that table.
