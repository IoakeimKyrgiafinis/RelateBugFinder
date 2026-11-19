import { execFile } from "child_process";
import { promisify } from "util";
import { CommitInfo, DirtyInfo } from "./types";
import { isPinned, nowSec } from "./clock";

const run = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  // GIT_OPTIONAL_LOCKS=0: never refresh .git/index as a side effect (avoids waking our own watchers).
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 128 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return stdout;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    return (await git(root, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

/** Tracked + untracked-but-not-ignored files, relative to `root`. */
export async function listGitFiles(root: string): Promise<string[]> {
  const out = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean);
}

/** Parse `@@ -a,b +c,d @@` into a range in the *new* file's numbering. */
function hunkRange(header: string): [number, number] | undefined {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return undefined;
  const start = Number(m[1]);
  const len = m[2] === undefined ? 1 : Number(m[2]);
  // len 0 = pure deletion just after `start`; still blame the surrounding line.
  return [Math.max(start, 1), Math.max(start, start + len - 1)];
}

function parseDiffFiles(lines: string[]): { path: string; ranges: [number, number][] }[] {
  const files: { path: string; ranges: [number, number][] }[] = [];
  let cur: { path: string; ranges: [number, number][] } | undefined;
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      cur = p === "/dev/null" ? undefined : { path: p.replace(/^b\//, ""), ranges: [] };
      if (cur) files.push(cur);
    } else if (line.startsWith("@@") && cur) {
      const r = hunkRange(line);
      if (r) cur.ranges.push(r);
    }
  }
  return files;
}

/**
 * Recent commits with per-file changed line ranges.
 * Note: ranges are in each commit's *post-image* numbering, so for older commits they
 * drift as later edits shift lines. That's why commits are weighted by recency anyway.
 */
export async function recentCommits(root: string, sinceDays = 30, max = 400): Promise<CommitInfo[]> {
  const RS = "\x1e", US = "\x1f";
  let out: string;
  try {
    const until = nowSec();
    out = await git(root, [
      "log", `--since=@${Math.floor(until - sinceDays * 86400)}`, ...(isPinned() ? [`--until=@${Math.floor(until)}`] : []), `--max-count=${max}`, "--no-color", "--no-renames", "--relative",
      "-U0", "-p", `--format=${RS}%H${US}%an${US}%at${US}%s`,
    ]);
  } catch {
    return []; // no commits yet
  }
  const commits: CommitInfo[] = [];
  for (const block of out.split(RS)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const [hash, author, at, message] = lines[0].split(US);
    commits.push({ hash, author, ts: Number(at), message: message ?? "", files: parseDiffFiles(lines.slice(1)) });
  }
  return commits;
}

/** Uncommitted changes (staged + unstaged vs HEAD) plus untracked files (whole file dirty). */
export async function dirtyRanges(root: string): Promise<DirtyInfo> {
  const ranges = new Map<string, [number, number][]>();
  try {
    const diff = await git(root, ["diff", "HEAD", "--no-color", "--no-renames", "--relative", "-U0"]);
    for (const f of parseDiffFiles(diff.split("\n"))) ranges.set(f.path, f.ranges);
  } catch {
    /* no HEAD yet: everything is untracked below */
  }
  try {
    const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const p of untracked.split("\0").filter(Boolean)) ranges.set(p, [[1, Number.MAX_SAFE_INTEGER]]);
  } catch {
    /* ignore */
  }
  return { ranges };
}

export function overlaps(ranges: [number, number][], start: number, end: number): boolean {
  return ranges.some(([a, b]) => a <= end && b >= start);
}
