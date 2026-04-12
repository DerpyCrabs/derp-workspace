# File Browser Plan

## Goal

Implement a JS-side local file browser plus shell-hosted viewers and editors that fit this compositor shell, reuse the existing workspace/window model, and borrow only the useful UX from `derp-media-server`.

This plan is for local desktop workflows, not for a web media library. It should feel like a desktop file manager first and a media-browser port second.

## Scope

In scope for this plan:

- Local filesystem browsing in shell-hosted windows
- Text, image, PDF, video, and unsupported-file flows
- Text editing for writable text files
- Workspace-aware opening rules so browser panes and viewers behave like normal shell windows
- Remote e2e coverage for real user interactions

Out of scope for now:

- Audio player behavior
- Share links, auth, passcodes, and share-scoped APIs
- Knowledge-base specific UX
- Server-sent live updates
- Server-backed favorites, usage stats, or media-library concepts

## What To Port From `UX expectations.md`

Keep directly:

- Breadcrumb navigation
- Parent navigation
- List and grid views
- Empty states and recoverable error states
- Context menus for file actions
- Viewer-specific handling for text, image, PDF, and unsupported files
- Opening directories in a browser and files in the appropriate viewer
- Workspace rules for new tab vs new window
- Immediate theme application and shell visual consistency

Adapt for desktop:

- Replace URL-driven state with per-window shell state plus persisted preferences
- Replace media-server virtual roots with real local roots and mounts
- Replace editable-folder gating with real filesystem capability and permission errors
- Replace browser-tab semantics with shell window and workspace group semantics
- Replace server upload flows with local create, rename, move, copy, drag, and paste flows
- Replace web deep-linking with reopen/recent-session behavior where it helps

Do not port now:

- Login flow
- Shares
- Share workspace
- KB search and markdown knowledge-base features
- View counts, most-played, and server analytics
- SSE synchronization model
- Audio-only playback behavior

## Desktop-Specific Expectations

The browser should satisfy normal desktop file-manager expectations even where the media-server UX does not cover them:

- Hidden files can be shown and hidden with a persistent preference
- Filesystem roots should start from local locations the user expects, not only app-defined library roots
- Multi-selection should exist before advanced file-management polish
- Keyboard navigation matters from day one
- Permission failures should be visible and actionable, not silently hidden
- Folders should show normal desktop metadata such as name, kind, modified time, and size where practical
- Unknown files should still be usable through download/save-as style fallback or external open
- Users should be able to choose `Open with` to hand a file off to a native app when the shell viewer is not preferred
- The shell should support real drag and drop between browser windows when the core model is stable

## Product Shape

Start with three shell-hosted window families:

1. Browser window
2. Viewer window
3. Editor window

The browser window is the navigator and action hub. Viewer and editor windows are document surfaces opened by the browser and managed by the existing workspace grouping logic.

Initial content types:

- Directory -> browser window
- Text-like file -> text viewer or text editor
- Image -> image viewer
- PDF -> PDF viewer
- Video -> video viewer
- Unknown binary file -> unsupported-file fallback with metadata and external-open path

Later content types:

- Richer file associations and external app chooser
- Archive handling

## Root Model

Do not copy the media-server root screen literally.

Day-one root entries should be local and predictable:

- Home
- Desktop
- Documents
- Downloads
- Pictures
- Videos
- Mounted volumes

Good follow-up entries:

- Recent
- Favorites
- Trash
- Computer or filesystem root

The browser should remember the last opened folder per browser window, but global bookmarks and recents can land after the first usable version.

## State Model

Use shell state, not routes, as the source of truth.

Recommended state split:

- Global persisted preferences: hidden-files toggle, sort mode, default browser view mode, default open target, sidebar collapse state
- Per-browser-window state: current directory, selection, view mode override, sort state, inline rename state, pending operation state
- Per-document-window state: file path, dirty flag, viewer transform state, last known metadata
- Workspace/session state: grouping, active tab, pinned tabs, split state, monitor placement

This should layer on top of the existing `workspaceState.ts` instead of replacing it.

## Bridge And Backend Plan

The current shell HTTP bridge is enough to prove the pattern but not enough for a file manager. Extend the compositor control server with dedicated filesystem endpoints instead of tunneling ad hoc shell JS.

Add filesystem endpoints for:

- Enumerate roots and mounted volumes
- List directory contents
- Stat a path
- Read text file
- Stream file bytes for images and PDFs
- Create file
- Create folder
- Rename
- Move
- Copy
- Delete
- Write text file
- Query native handlers or candidates for `Open with`
- Launch a file in a chosen native app
- Reveal permission and IO errors in structured form

Important backend rules:

- Canonicalize paths per operation
- Preserve symlink information instead of flattening everything into plain files
- Return enough metadata for sorting and viewer decisions without extra round-trips
- Support range requests or efficient binary reads for larger PDF and image assets
- Keep endpoints local-only through the existing loopback shell HTTP bridge
- Keep `Open with` launches explicit and user-initiated, never implicit on background inspection

Recommended response shape for directory listing:

- Absolute path
- Display name
- File kind
- Hidden flag
- Symlink flag
- Writable flag if cheap to compute
- Size
- Modified time
- Mime hint or extension-derived kind

## Shell Window Model

Reuse the existing shell-backed window flow instead of inventing a second host model.

Implementation direction:

- Add new shell-backed window ids or a generic shell-backed document-window allocator
- Render browser/viewer/editor content through the same shell-hosted measurement and frame system used by settings and test windows
- Keep geometry and focus in the compositor window map
- Keep browser-specific and document-specific state in JS

This avoids pretending that the file browser is a native Wayland client and keeps it aligned with the existing tab-group and taskbar logic.

## Opening Rules

Map filesystem open behavior onto the workspace rules already being built:

- Opening a directory opens a browser window or browser tab
- Opening a file opens the matching viewer or editor window
- The default target follows the workspace open preference: new tab or new window
- Reopening the same path should prefer focusing the existing shell-hosted document window instead of spawning duplicates when that feels predictable
- Browser panes should be able to target another group once the open-target picker is ready
- Any file row should also support `Open with` so the user can launch the file in a native app instead of the shell-hosted viewer/editor

`Open with` behavior should start simple:

- First pass can offer `Open externally` and a small list of obvious native candidates
- Later passes can expand into a fuller chooser with remembered per-extension preferences
- Shell-hosted viewers remain the default for supported types unless the user explicitly chooses otherwise

Early duplicate-handling policy:

- Reuse existing text/image/PDF windows by path within the current workspace session
- Always allow opening a second browser window for a folder when the user explicitly requests it

## Browser UX Phases

### Phase 1: Test Fixture And Harness Foundation

Before the browser MVP, add a stable test fixture set so the feature can be validated with real files instead of relying on the host machine's incidental contents.

Deliverables:

- A dedicated local test-media tree that remote e2e can create or refresh deterministically
- Fixture coverage for empty folders, hidden files, nested folders, writable text files, read-only text files, images, PDFs, videos, and unsupported binaries
- One helper path for preparing these fixtures before browser tests run
- Shell snapshot hooks and test controls for browser rows, breadcrumbs, active path, viewer/editor title, and primary viewer actions
- Cleanup or reset behavior so tests can manipulate files without polluting later runs

Preferred fixture strategy:

- Generate the fixture tree on the remote machine from scripts or test helpers
- Keep source fixture descriptions in the repo
- Keep binary fixtures intentionally small so sync and e2e remain fast
- Include at least one hidden file and one hidden directory
- Include at least one small playable video fixture with a predictable duration
- Include at least one PDF fixture and one image fixture with stable dimensions

This phase should make the browser and viewer work testable before the UI surface grows.

### Phase 2: Browser MVP

Deliver a usable read-only browser window:

- Sidebar with local roots
- Breadcrumbs
- Parent navigation
- List view first, grid second
- File metadata columns in list view
- Double-click or Enter to open
- Empty state
- Loading state
- Error state with retry
- Hidden-files toggle
- Manual refresh

Desktop-first choices in this phase:

- The root screen shows local folders and mounts, not favorites and shares
- Unsupported files are still openable into a fallback viewer window
- Keyboard selection and navigation are included immediately

### Phase 3: Selection, Menus, And Basic Operations

Add normal file-manager interactions:

- Single-select and multi-select
- Shift and Ctrl selection
- Context menus for files, folders, and background
- Create file
- Create folder
- Rename
- Delete
- Move
- Copy
- Drag between folders and between browser windows
- `Open with` and `Open externally` from file context menus

Desktop-specific rule:

- Show actions based on broad file kind, then surface actual permission errors from the backend instead of hiding most actions the way the media server does for read-only areas
- Treat `Open with` as a normal desktop file action, not as an unsupported-file escape hatch only

### Phase 4: Text Viewer And Editor

Add the first editor because it unlocks real local workflows quickly.

Requirements:

- Open text-like files in a shell-hosted document window
- Support read-only mode when writes fail or the file is not writable
- Support dirty-state tracking
- Prompt on close when there are unsaved changes
- Save and reload
- Detect external modification on focus or explicit reload before solving full file watching

Good initial text types:

- `.txt`
- `.md`
- `.json`
- `.js`
- `.ts`
- `.tsx`
- `.rs`
- `.toml`
- `.yaml`
- `.yml`

Large-file guardrail:

- Use a size threshold that opens huge files read-only first instead of freezing the shell

### Phase 5: Image, PDF, And Video Viewers

Add viewer windows with minimal but desktop-appropriate controls.

Image viewer:

- Fit to window
- Actual size
- Zoom in and out
- Pan
- Rotate
- Next and previous within the current directory selection

PDF viewer:

- Filename
- Download or save copy if needed
- Open externally
- Open with native app
- Page scrolling
- Zoom

Video viewer:

- Play and pause
- Seek
- Mute and volume
- Current time and duration
- Fullscreen inside the shell window model if practical
- Reopen should focus the existing video window by path when reasonable
- Open with native app

Viewer behavior rules:

- Image, PDF, and video viewers should open in normal shell windows, not modal overlays
- Reopen should focus existing windows by path when reasonable
- Viewer state such as zoom and fit can stay per-window and non-persisted at first
- Do not implement audio-only mode in this plan

### Phase 6: Desktop Polish

After the core browser and viewers are stable, add the features that make it feel like a real DE app:

- Grid view polish with thumbnails
- Sort and filter controls
- Cut, copy, and paste
- Bookmarking and favorites
- Recents
- Trash instead of permanent delete as the default
- External-open and open-with flows
- Remembered file associations after the basic chooser works
- File properties dialog
- Better drag previews and drop affordances
- Refresh on external filesystem changes

## Viewer And Editor Content Detection

Use a simple decision stack first:

- Directory by stat result
- Text by extension plus small binary sniff
- Image by mime or extension
- PDF by mime or extension
- Video by mime or extension
- Everything else -> unsupported fallback

Avoid overengineering file associations in the first slice. The browser only needs to answer "open in browser, viewer, editor, or fallback" reliably.

## Error Handling

The media-server doc is right that silent failure is bad. Keep that rule.

Required user-visible errors:

- Directory load failure
- Permission denied
- Missing path after an external change
- Save conflict or stale file
- Failed rename or move because target exists
- Unsupported viewer type

Use toast or inline error surfaces depending on scope:

- Inline for current-window loading problems
- Toast for one-shot actions like rename or delete

## Persistence

Persist only what improves local desktop behavior without recreating the web app's URL model:

- Hidden-files preference
- Default list or grid mode
- Preferred sort mode
- Preferred open target
- Last sidebar width if resizable

Do not persist ephemeral selection state across reloads.

## Testing Plan

This feature needs remote e2e coverage because it is shell UI plus window-management behavior.

Add or extend remote e2e for:

- Open a browser shell window
- Navigate roots, breadcrumbs, and parent folder
- Toggle hidden files and verify dotfiles appear
- Keyboard navigation and Enter-to-open
- Open a text file into an editor window
- Edit, save, close, and reopen text content
- Open an image into a viewer window
- Open a PDF into a viewer window
- Open a video into a viewer window and verify play or pause plus seek state
- Open a file through `Open with` and verify the native launch path is invoked
- Error state when a file disappears or permission fails
- Browser and viewer taskbar rows stay aligned on multi-monitor setups
- Open-target behavior for new tab vs new window when wired in

Test strategy notes:

- Use real pointer and keyboard interactions through the remote harness
- Add shell snapshot controls for browser rows, breadcrumbs, toggle buttons, and viewer controls as needed
- Keep fetched artifacts under `.artifacts/e2e`
- Do not run these tests in parallel

## Suggested File Layout

Likely new shell files:

- `shell/src/fileBrowserState.ts`
- `shell/src/fileBrowserPrefs.ts`
- `shell/src/FileBrowserWindow.tsx`
- `shell/src/FileBrowserSidebar.tsx`
- `shell/src/FileBrowserList.tsx`
- `shell/src/FileBrowserGrid.tsx`
- `shell/src/FileBrowserContextMenu.tsx`
- `shell/src/documentWindows.ts`
- `shell/src/TextEditorWindow.tsx`
- `shell/src/ImageViewerWindow.tsx`
- `shell/src/PdfViewerWindow.tsx`
- `shell/src/VideoViewerWindow.tsx`
- `shell/src/fileType.ts`
- `shell/src/fileBrowserBridge.ts`

Likely compositor work:

- `compositor/src/cef/control_server.rs`
- New filesystem helper module under `compositor/src/cef/` or nearby

Likely e2e work:

- New `shell/e2e/specs/file-browser.spec.ts`
- Possible runtime helpers in `shell/e2e/lib/runtime.ts`

## Recommended Delivery Order

1. Filesystem bridge and typed shell bridge client
2. Test-media fixture generation and remote e2e hooks
3. Shell-hosted browser window MVP
4. Hidden-files toggle, keyboard navigation, and list metadata
5. Text viewer and editor with save flow
6. Image, PDF, and video viewers
7. Context menus and basic file operations
8. Multi-select and drag between folders or windows
9. Open-target integration with workspace tab or window preference
10. Recents, favorites, thumbnails, and external file-change refresh

## First PR Slice

The best first implementation slice is:

1. Add filesystem list and read endpoints
2. Add deterministic remote test-media fixture setup covering hidden files, text, image, PDF, video, and unsupported files
3. Add a shell-hosted browser window that can open, list, enter directories, go to parent, and toggle hidden files
4. Add text-file open into a simple read-only viewer window
5. Add remote e2e for browser open, navigation, hidden files, fixture traversal, and text-file open

That slice proves the browser architecture, validates the bridge shape, and gives a desktop-useful result without taking on editing, thumbnails, drag and drop, or media complexity too early.

## Explicit Deferrals

Defer these until the core browser and document windows are stable:

- Audio player
- Knowledge-base features
- Share model
- URL deep-link parity
- SSE-style live sync
- Usage analytics
- Trash semantics if they would slow down the first browser cut too much
