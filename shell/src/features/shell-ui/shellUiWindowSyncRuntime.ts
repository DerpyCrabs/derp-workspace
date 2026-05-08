import { createShellSharedStateSync } from "@/features/bridge/shellSharedStateSync";

export function createShellUiWindowSyncRuntime(
  options: Parameters<typeof createShellSharedStateSync>[0],
) {
  return createShellSharedStateSync(options);
}
