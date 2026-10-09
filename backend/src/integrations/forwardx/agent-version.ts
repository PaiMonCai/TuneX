/** Strict SemVer admission; build metadata never changes precedence. */
interface Version {
  core: readonly number[];
  prerelease: readonly string[];
}

function parseVersion(value: string): Version | null {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim());
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { core, prerelease };
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return !a.prerelease.length ? (!b.prerelease.length ? 0 : 1) : -1;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i], right = b.prerelease[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    if (ln !== rn) return ln ? -1 : 1;
    if (ln) return left.length !== right.length ? (left.length < right.length ? -1 : 1) : (left < right ? -1 : 1);
    return left < right ? -1 : 1;
  }
  return 0;
}

export type AgentVersionFailure = "agent_version_unknown" | "agent_version_invalid" | "agent_version_too_old" | "minimum_agent_version_invalid";

/** A prerelease cannot satisfy its corresponding stable floor. */
export function checkAgentVersion(version: string | null, minimum: string | null): AgentVersionFailure | null {
  const value = version?.trim() ?? "";
  if (!value || value.toLowerCase() === "unknown") return "agent_version_unknown";
  const parsed = parseVersion(value);
  if (!parsed) return "agent_version_invalid";
  if (minimum === null) return null;
  const floor = parseVersion(minimum);
  if (!floor) return "minimum_agent_version_invalid";
  return compare(parsed, floor) < 0 ? "agent_version_too_old" : null;
}
