import * as path from "path";
import { StackFrame } from "./types";

export interface ParsedTrace {
  message?: string;
  /** Normalised crash-first: frames[0] is where the error was thrown. */
  frames: StackFrame[];
  language: "js" | "py" | "mixed" | "unknown";
}

const V8 = /^\s*at\s+(?:async\s+)?(?:(new\s+)?([^\s(][^(]*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const FIREFOX = /^\s*([^@\s]*)@(.+?):(\d+):(\d+)\s*$/;
const PY = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?\s*$/;
// pytest: `--tb=short` prints `path.py:12: in fn`; the default long format prints `path.py:12: ` between
// frames and `path.py:12: AttributeError` for the last one.
const PYTEST = /^((?:[A-Za-z]:)?[^\s:][^:]*\.py):(\d+):(?: in (\S+)| ([A-Z]\w*(?:Error|Exception|Exit|Interrupt|Warning)\w*))?\s*$/;
const TSC = /^([^\s(][^(]*\.[cm]?[jt]sx?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*[-:]\s*error/;
const GENERIC = /((?:[A-Za-z]:)?[\w./\\@-]+\.(?:[cm]?[jt]sx?|py)):(\d+)(?::(\d+))?/;
// `E   AttributeError: …` is pytest's error line.
const ERRMSG = /^\s*(?:E\s{2,})?(?:Uncaught\s+)?((?:[A-Z]\w*)?(?:Error|Exception|Exit)\b.*?)\s*$/;

/** Strip URL/bundler prefixes so the remaining path can be matched against the workspace. */
export function cleanPath(p: string): string {
  let s = p.trim();
  s = s.replace(/^file:\/\/\/?/, "/").replace(/^\/([A-Za-z]:)/, "$1");
  s = s.replace(/^webpack(-internal)?:\/\/\/?(\([^)]*\)\/)?/, "");
  s = s.replace(/^https?:\/\/[^/]+\//, "");
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/^\.\//, "");
  return s.split("\\").join("/");
}

export function parseStackTrace(text: string): ParsedTrace {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const js: StackFrame[] = [];
  const py: StackFrame[] = [];
  const tsc: StackFrame[] = [];
  let message: string | undefined;

  for (const raw of lines) {
    let m: RegExpExecArray | null;
    if ((m = V8.exec(raw))) {
      const file = m[3];
      if (file.startsWith("node:") || file.includes("node_modules") || file === "<anonymous>" || file.startsWith("internal/")) continue;
      js.push({ raw: raw.trim(), fn: normaliseFn(m[2]), file: cleanPath(file), line: +m[4], col: +m[5] });
    } else if ((m = PY.exec(raw))) {
      // Third-party and stdlib frames (posix lib/pythonX.Y, Windows <Python>\Lib\...).
      if (/site-packages|dist-packages|<frozen|lib\/python\d|[\\/]Python\d*[\\/]Lib[\\/]/.test(m[1])) continue;
      py.push({ raw: raw.trim(), fn: m[3]?.trim(), file: cleanPath(m[1]), line: +m[2] });
    } else if ((m = PYTEST.exec(raw))) {
      if (/site-packages|dist-packages|lib\/python\d|[\\/]Python\d*[\\/]Lib[\\/]/.test(m[1])) continue;
      py.push({ raw: raw.trim(), fn: m[3], file: cleanPath(m[1]), line: +m[2] });
    } else if ((m = FIREFOX.exec(raw)) && /\.[cm]?[jt]sx?/.test(m[2])) {
      js.push({ raw: raw.trim(), fn: m[1] || undefined, file: cleanPath(m[2]), line: +m[3], col: +m[4] });
    } else if ((m = TSC.exec(raw))) {
      tsc.push({ raw: raw.trim(), file: cleanPath(m[1]), line: +(m[2] ?? m[4]), col: +(m[3] ?? m[5]) });
      message ??= raw.trim();
    }
    if (!message) {
      const em = ERRMSG.exec(raw);
      if (em && !V8.test(raw) && !raw.trim().startsWith("File ")) message = em[1].slice(0, 300);
    }
  }

  // Python prints most-recent-call LAST → reverse to crash-first.
  const frames = [...js, ...py.reverse(), ...tsc];
  if (!frames.length) {
    // Last resort: any `file.ext:line` mention (e.g. a one-line error from a linter or logger).
    for (const raw of lines) {
      const m = GENERIC.exec(raw);
      if (m) frames.push({ raw: raw.trim(), file: cleanPath(m[1]), line: +m[2], col: m[3] ? +m[3] : undefined });
    }
  }
  const language = js.length && py.length ? "mixed" : js.length || tsc.length ? "js" : py.length ? "py" : "unknown";
  return { message, frames: dedupe(frames), language };
}

function normaliseFn(fn?: string): string | undefined {
  if (!fn) return undefined;
  return fn.replace(/^Object\./, "").replace(/^Module\./, "").replace(/ \[as \w+\]$/, "").trim() || undefined;
}

function dedupe(frames: StackFrame[]): StackFrame[] {
  const seen = new Set<string>();
  return frames.filter((f) => {
    const k = `${f.file}:${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Map a printed path onto an indexed workspace file: absolute-under-root first, then the
 * longest indexed path that is a suffix of it (handles Docker `/app/...`, CI checkouts, bundler prefixes),
 * then `dist|build|out/x.js` → `src/x.ts` when no source map was applied.
 */
export function mapToWorkspace(printed: string, root: string, indexed: Iterable<string>): string | undefined {
  const files = [...indexed];
  const set = new Set(files);
  const rootPosix = root.split("\\").join("/").replace(/\/$/, "");
  let p = printed;
  if (p.toLowerCase().startsWith(rootPosix.toLowerCase() + "/")) p = p.slice(rootPosix.length + 1);
  if (set.has(p)) return p;
  let best: string | undefined;
  for (const f of files) if ((p === f || p.endsWith("/" + f)) && (!best || f.length > best.length)) best = f;
  if (best) return best;
  const m = /(?:^|\/)(?:dist|build|out|lib)\/(.+)\.[cm]?js$/.exec(p);
  if (m) for (const ext of [".ts", ".tsx", ".js"]) {
    const c = `src/${m[1]}${ext}`;
    if (set.has(c)) return c;
  }
  const base = path.posix.basename(p);
  const sameBase = files.filter((f) => path.posix.basename(f) === base);
  return sameBase.length === 1 ? sameBase[0] : undefined;
}
