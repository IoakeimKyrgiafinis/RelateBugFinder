// Decide whether a failing test actually exercised the bug, or broke for an unrelated reason on this
// machine. Applied identically to every method, before any scoring. Shared by bugsinpy.mjs and rescore.mjs.

/** @returns a short reason when the failure is the environment, not the bug; otherwise undefined. */
export function envReason(rec, trace = "") {
  if (rec.framesInWorkspace === 0) return "no frame in the project's code";
  const msg = rec.message ?? "";
  // The test module never loaded: an import failed (old pinned dependency, missing optional package...).
  if (/^(ImportError|ModuleNotFoundError)\b|^ImportError while importing test module|Failed to import test module/.test(msg)) return "test could not be imported";
  // The failure happened while some module was being imported (top-level code), before any test ran.
  if (rec.crashSite && rec.crashSite.endsWith("#<module>")) return "failed while importing a module";
  // Windows' default asyncio loop has no add_reader/add_writer (Unix-only API).
  if (/^NotImplementedError/.test(msg) && /asyncio[\\/]events\.py", line \d+, in add_(reader|writer)/.test(trace)) return "asyncio add_reader is not supported on Windows";
  return undefined;
}
