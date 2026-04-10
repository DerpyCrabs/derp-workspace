# Workspace Migration Roadmap

This roadmap uses the `derp-media-server` workspace folder as the reference surface:

- `https://github.com/DerpyCrabs/derp-media-server/tree/master/src/workspace`

The order is optimized for `UX improvement / implementation difficulty`, while still keeping dependencies after their prerequisites.

## Migration Rules

- Treat the current compositor window map as the source of truth for native window geometry, focus, minimize, maximize, and output assignment.
- Layer workspace-only metadata in the JS shell instead of forcing everything into the compositor protocol on day one.
- Reuse existing shell pieces first: `shell/src/App.tsx`, `shell/src/ShellWindowFrame.tsx`, `shell/src/Taskbar.tsx`, `shell/src/SnapAssistMasterGrid.tsx`, `shell/src/assistGrid.ts`, `shell/src/tileState.ts`, and the existing shell-hosted window plumbing.
- Only add compositor protocol when the feature truly needs native state, not just richer shell presentation.
- After each implementation step, run `bash scripts/verify.sh`, then `bash scripts/remote-update-and-restart.sh`, then `bash scripts/remote-verify.sh`.

## Ordered Steps

| # | Step | UX | Difficulty | Depends on |
|---|---|---|---|---|
| 1 | Port all themes and theme settings | High | Low | None |
| 2 | Promote snap assist into a first-class picker | High | Low | None |
| 3 | Add persisted workspace session state in the shell | High | Medium | None |
| 4 | Add tab groups and a visible tab strip for compositor windows | Very high | Medium | 3 |
| 5 | Make the taskbar group-aware | High | Low | 4 |
| 6 | Add drag-to-merge, reorder, and pinning for tabs | High | Medium | 4 |
| 7 | Add split view inside a tab group | High | Medium | 6 |
| 8 | Add named layouts with save, restore, and preview | High | Medium | 3, 4, 7 |
| 9 | Add a shell-hosted workspace browser MVP | Very high | High | 3, 4 |
| 10 | Expand browser-pane workflows and modal actions | High | High | 9 |
| 11 | Port remaining settings and polish features last | Medium | Medium | 5, 8, 10 |

## 1. Port All Themes And Theme Settings

Reference targets: `WorkspaceTaskbarSettings.tsx`

- Port the full theme palette and theme mode model first so later workspace UI lands on the final visual system instead of being restyled repeatedly.
- Bring over the reference concepts for palette selection and mode selection: `light`, `dark`, `system`, plus the reference palettes that make sense locally.
- Keep theme state shell-local and persisted in the browser, not in compositor protocol.
- Apply the theme system to existing shell surfaces first: taskbar, shell window chrome, menus, settings window, snap assist UI, and any shell-hosted windows.
- Port only theme-related settings in this step. Leave file-open target, audio, and other workspace settings for the final polish step.

Suggested local files:

- New `shell/src/themeStore.ts` or equivalent
- New `shell/src/themeDom.ts` or equivalent
- `shell/src/Taskbar.tsx`
- `shell/src/ShellWindowFrame.tsx`
- `shell/src/App.tsx`
- `shell/src/SettingsPanel.tsx`

Done when:

- All current shell UI respects the selected theme palette and mode.
- Theme choice survives shell reloads.
- New workspace UI added in later steps can consume one shared theme system instead of adding one-off colors.

## 2. Promote Snap Assist Into A First-Class Picker

Reference targets: `WorkspaceSnapAssistBar.tsx`, `WorkspaceTilingPicker.tsx`, `WorkspaceSnapAssistMasterGrid.tsx`, `snap-preview.ts`

- Keep the current snap math in `shell/src/assistGrid.ts`, `shell/src/tileZones.ts`, `shell/src/tileState.ts`, and `shell/src/App.tsx`.
- Add a top-center strip trigger and an explicit tiling picker anchored to the focused window chrome.
- Reuse the existing `SnapAssistMasterGrid` component instead of re-porting the reference grid literally.
- Add hover preview parity so the chosen grid span is visible before drop/commit.
- Keep this step shell-only unless a missing native action appears during implementation.

Done when:

- A user can trigger snap assist both by drag and by an explicit picker.
- The picker supports the same layouts the current assist grid already understands.
- A picked layout snaps the focused window without breaking existing drag-to-edge behavior.

## 3. Add Persisted Workspace Session State In The Shell

Reference targets: `workspace-page-persistence.ts`, `tab-group-ops.ts`

- Create a new shell state module that stores workspace-only metadata for native windows: group id, active tab per group, pinned state, split state, and saved layout metadata.
- Persist that state in `localStorage` so shell restarts do not lose workspace organization.
- Keep native window records from `window_list` and `window_state` separate from workspace session state, then derive combined view models in memos/selectors.
- Add focused reducer-style tests next to the shell state module.

Suggested local files:

- New `shell/src/workspaceState.ts`
- New `shell/src/workspaceState.test.ts`
- `shell/src/App.tsx`

Done when:

- Tab/group metadata survives a shell reload.
- Native window geometry still comes only from compositor events.
- Removing a window cleans up its workspace metadata automatically.

## 4. Add Tab Groups And A Visible Tab Strip For Compositor Windows

Reference targets: `WorkspaceTabStrip.tsx`, `tab-group-ops.ts`

- Render a tab strip above grouped native windows using the existing `ShellWindowFrame` chrome area as the anchor.
- Start with simple grouping: one native window equals one tab group until the user merges groups.
- Show active tab title, close button, focus behavior, and minimized state correctly.
- Switch visible tab content by hiding non-active group members in the shell while leaving native window ownership unchanged.
- Add keyboard shortcuts for next tab and previous tab once the basic strip works.

Suggested local files:

- New `shell/src/WorkspaceTabStrip.tsx`
- `shell/src/ShellWindowFrame.tsx`
- `shell/src/App.tsx`

Done when:

- Grouped windows render as tabs on one frame.
- Selecting a tab focuses the correct native window.
- Closing or unmapping the active tab promotes the next sensible tab.

## 5. Make The Taskbar Group-Aware

Reference targets: `WorkspaceTaskbarRows.tsx`

- Replace one-button-per-window taskbar rows with one-button-per-group rows.
- Show the active tab title and a `(+N)` indicator when a group has multiple tabs.
- Make click behavior match workspace expectations: restore minimized groups, focus inactive groups, minimize active groups.
- Preserve per-monitor taskbar behavior that already exists in `shell/src/App.tsx`.

Suggested local files:

- `shell/src/Taskbar.tsx`
- `shell/src/App.tsx`
- Possibly new `shell/src/taskbarGroups.ts`

Done when:

- The taskbar stops exploding horizontally when many tabs belong to one logical workspace group.
- Group rows restore and minimize predictably.

## 6. Add Drag-To-Merge, Reorder, And Pinning For Tabs

Reference targets: `WorkspaceTabStrip.tsx`, `tab-group-ops.ts`, `merge-target.ts`

- Support dragging one tab onto another group to merge them.
- Support reordering tabs within a group.
- Support pinned tabs inside a group, but keep pinning shell-local for the first pass.
- Use DOM hit-testing in the shell first, like the reference, before inventing compositor-assisted drop targeting.
- Add focused tests for merge index calculations and group reorder operations.

Suggested local files:

- `shell/src/WorkspaceTabStrip.tsx`
- New `shell/src/tabGroupOps.ts`
- New `shell/src/tabGroupOps.test.ts`
- `shell/src/App.tsx`

Done when:

- Dragging a tab between groups changes group membership deterministically.
- Reordering and pinning survives reload because it is backed by workspace session state.

## 7. Add Split View Inside A Tab Group

Reference targets: split-left behavior inside `WorkspaceTabStrip.tsx`

- Add a lightweight split model with one left tab and one right-side tab strip before attempting arbitrary multi-pane layouts.
- Reuse current native window bounds and snap logic instead of building a second full layout engine.
- Let users move a tab into split view from the tab context menu first, then add drag affordances later.
- Make exit-split behavior collapse back into a normal tab group without losing tab order.

Suggested local files:

- `shell/src/WorkspaceTabStrip.tsx`
- `shell/src/App.tsx`
- `shell/src/workspaceState.ts`

Done when:

- A group can show two native windows side by side.
- Focus and close behavior remain predictable when one split side disappears.

## 8. Add Named Layouts With Save, Restore, And Preview

Reference targets: `WorkspaceNamedLayoutMenu.tsx`, `WorkspaceLayoutHoverPreview.tsx`

- Persist a serializable snapshot of tab groups, split state, pinned tabs, chosen monitor, and snapped bounds.
- Start with local saved layouts only. Do not copy the reference server-backed preset storage model.
- Add a small hover preview component so saved layouts are inspectable before restore.
- Implement restore in two passes: restore shell grouping first, then replay native move/snap actions through the existing wire API.
- Add a baseline concept only after save and restore work reliably.

Suggested local files:

- New `shell/src/workspaceLayouts.ts`
- New `shell/src/WorkspaceNamedLayoutMenu.tsx`
- New `shell/src/WorkspaceLayoutHoverPreview.tsx`
- `shell/src/App.tsx`

Done when:

- A user can save the current workspace arrangement, restore it later, and preview it before applying it.
- Restore works across multiple monitors as long as the monitor names still exist.

## 9. Add A Shell-Hosted Workspace Browser MVP

Reference targets: `WorkspaceBrowserPane.tsx`, `workspace-page-persistence.ts`

- Do not port the full reference browser pane first. Start with a minimal local-file workspace browser inside a shell-hosted window.
- Reuse the existing shell-hosted window mechanism instead of pretending the browser pane is a native Wayland client.
- Add only the MVP data flows first: list directory, enter directory, go to parent, and open files.
- Build a small local bridge for filesystem operations. `shell/src/shellBridge.ts` is currently too small for this, so expect new bridge endpoints or a helper process.
- Keep the first version local-only. Ignore share-token, knowledge-base, and upload-to-server behavior.

Suggested local files:

- New `shell/src/WorkspaceBrowserPane.tsx`
- `shell/src/shellBridge.ts`
- `shell/src/App.tsx`
- Possibly compositor-side or helper-side filesystem bridge code if HTTP-only is insufficient

Done when:

- The shell can open a browser pane as a shell-hosted window.
- The pane can browse local directories and open a file into the existing default action.

## 10. Expand Browser-Pane Workflows And Modal Actions

Reference targets: `WorkspaceBrowserModalLayer.tsx`, more of `WorkspaceBrowserPane.tsx`

- Add create file, create folder, rename, delete, move, and drag-drop after the MVP browser pane is stable.
- Add modal layering and context menus only after the basic file operations work.
- Keep actions local-only first. Leave sharing, knowledge-base toggles, and remote library semantics for a later phase.
- Route new file opens through one helper so a later settings UI can choose the open target without another refactor.

Suggested local files:

- New `shell/src/WorkspaceBrowserModalLayer.tsx`
- `shell/src/WorkspaceBrowserPane.tsx`
- `shell/src/shellBridge.ts`

Done when:

- Common file-management flows work without leaving the compositor shell.
- Browser-pane modals do not break focus or pointer routing for native windows underneath.

## 11. Port Remaining Settings And Polish Features Last

Reference targets: `WorkspaceTaskbarSettings.tsx`, `WorkspaceTaskbarAudio.tsx`

- Add shell settings for default open target, snap-assist preference, and non-theme workspace behavior only after the main workspace model is stable.
- Only port audio controls if the current project has a reliable local audio control bridge. Do not block the workspace migration on this.
- Keep these settings shell-local unless they clearly belong in compositor config.
- Use this phase to clean up keyboard shortcuts, empty states, hover states, and accessibility gaps introduced by earlier steps.

Done when:

- Settings expose the new workspace behaviors without adding protocol debt.
- The shell feels cohesive rather than like a stack of unrelated ports.

## Features To Defer

- Share-token flows from the reference app
- Knowledge-base and search-specific features
- Server-backed query caching assumptions
- Remote media-server concepts that do not map cleanly onto a local compositor shell

## Recommended First PR Slice

If this roadmap is executed in small AI-friendly slices, the best first slice is:

1. Step 1
2. Step 2 without changing compositor protocol
3. Step 3 with tests
4. The non-dragging subset of step 4

That sequence delivers visible UX improvement quickly and creates the state foundation needed for the harder workspace features later.
