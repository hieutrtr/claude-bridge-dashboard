// T11 — predicate for the discovery boundary's offline error.
//
// We discriminate by `name`, not `instanceof`, because Next.js
// serializes errors thrown inside an RSC across to the client error
// boundary and the prototype is stripped in the process. The name
// field survives, so a name-based check works in both the server-only
// happy path (real BridgeNotInstalledError instance) and the
// server→client boundary path (plain object with the canonical name).

export const BRIDGE_NOT_INSTALLED_NAME = "BridgeNotInstalledError";

export function isBridgeNotInstalledError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === BRIDGE_NOT_INSTALLED_NAME;
}
