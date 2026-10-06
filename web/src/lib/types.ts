/**
 * Compatibility facade for TuneX Web domain types.
 *
 * New code may import from ./types/<domain>; existing callers can keep
 * importing "@/lib/types" while the repository migrates incrementally.
 */
export * from "./types/base";
export * from "./types/attention";
export * from "./types/admin-inputs";
export * from "./types/node-forward";
export * from "./types/node-health";
export * from "./types/node-lifecycle";
export * from "./types/diagnostics";
export * from "./types/federation";
export * from "./types/route-profile";
