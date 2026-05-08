import { createSessionPersistenceRuntime } from "@/features/bridge/sessionPersistenceRuntime";

export function createAppSessionPersistenceRuntime(
  options: Parameters<typeof createSessionPersistenceRuntime>[0],
) {
  return createSessionPersistenceRuntime(options);
}
