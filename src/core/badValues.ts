/**
 * Which concrete values does an error say were wrong? Used with a deep trace's recorded return values
 * (deepTrace.ts `rets`) to find the function that *produced* the bad value, even when it already returned.
 *
 *   unittest   AssertionError: -10.0 != 90           → -10.0 (actual: unittest's first argument), 90
 *   pytest     E   assert -10.0 == 90                 → -10.0 (actual), 90
 *              E    +  where -10.0 = order_total(10)  → -10.0 (actual)
 *   any error  ValueError: negative total: -10.0      → -10.0      KeyError: 'eur' → 'eur'
 *   None       'NoneType' object has no attribute 'x' → None
 *
 * Values are compared with the recorder's summaries: repr() for None, booleans, numbers and short strings.
 */

export interface BadValue {
  /** As the recorder would summarise it (repr): `-10.0`, `'eur'`, `None`. */
  v: string;
  /** "actual": the value the code produced; "mentioned": a value the message names (could be either side). */
  role: "actual" | "mentioned";
}

/** Values too common to point anywhere on their own (many functions return them). */
export const TRIVIAL = new Set(["None", "True", "False", "0", "1", "-1", "''", '""', "[]", "{}", "()", "set()"]);

const NUM = /^-?(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?$/i;
const STR = /^(['"])(.{0,60})\1$/s;

/** Normalise one side of a comparison to a recorder summary, or undefined when it isn't a simple value. */
export function asSummary(raw: string): string | undefined {
  const s = raw.trim().replace(/[.,;]$/, "");
  if (!s || s.length > 80) return undefined;
  if (s === "None" || s === "True" || s === "False") return s;
  if (NUM.test(s)) return s;
  const m = STR.exec(s);
  if (m) return `'${m[2].replace(/'/g, "\\'")}'`;
  if (/^(\[\]|\{\}|\(\)|set\(\))$/.test(s)) return s;
  return undefined;
}

/** Same value? Numbers compare numerically (90 == 90.0), strings ignore which quote was used. */
export function sameValue(recorded: string, bad: string): boolean {
  if (recorded === bad) return true;
  if (NUM.test(recorded) && NUM.test(bad)) return Number(recorded) === Number(bad);
  const a = STR.exec(recorded), b = STR.exec(bad);
  return !!a && !!b && a[2] === b[2];
}

export function badValues(message: string | undefined, traceText = ""): BadValue[] {
  const out: BadValue[] = [];
  const add = (raw: string | undefined, role: BadValue["role"]) => {
    const v = raw === undefined ? undefined : asSummary(raw);
    if (v && !out.some((x) => x.v === v)) out.push({ v, role });
    else if (v && role === "actual") out.find((x) => x.v === v)!.role = "actual";
  };
  const msg = (message ?? "").replace(/^\s*(?:E\s+)?(?:[\w.]+(?:Error|Exception|Failure)):\s*/, "");

  // unittest assertEqual & co: "first != second" (first is what the code produced, by convention).
  const ut = /^(.{1,80}?) != (.{1,80}?)(?: : .*)?$/.exec(msg.split("\n")[0]);
  if (ut) { add(ut[1], "actual"); add(ut[2], "mentioned"); }

  // pytest assertion rewriting: "assert A == B" and "+  where A = f(...)".
  for (const line of traceText.split(/\r?\n/)) {
    const pa = /^E\s+(?:AssertionError: )?assert (.{1,80}?) (?:==|!=|<=|>=|<|>|is not|is|not in|in) (.{1,80})$/.exec(line);
    if (pa) { add(pa[1], "actual"); add(pa[2], "mentioned"); }
    const where = /^E\s+\+\s+where (.{1,80}?) = [\w.]+\(/.exec(line);
    if (where) add(where[1], "actual");
  }
  const pm = /^assert (.{1,80}?) (?:==|!=|<=|>=|<|>|is not|is|not in|in) (.{1,80})$/.exec(msg.split("\n")[0]);
  if (pm) { add(pm[1], "actual"); add(pm[2], "mentioned"); }

  // Python's None errors.
  if (/'NoneType' object|NoneType\b|argument must be .*, not 'NoneType'|None has no attribute/.test(message ?? "")) add("None", "actual");

  // Any other value the message names: numbers and quoted strings (KeyError: 'eur', "negative total: -10.0").
  if (!ut && !pm) {
    const first = msg.split("\n")[0];
    for (const m of first.matchAll(/'([^'\n]{1,60})'|"([^"\n]{1,60})"|(?<![\w.])(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?![\w.])/gi)) {
      if (/^ object\b/.test(first.slice(m.index! + m[0].length))) continue; // "'Cart' object has no …": a type name
      add(m[1] !== undefined ? `'${m[1]}'` : m[2] !== undefined ? `"${m[2]}"` : m[3], "mentioned");
    }
  }
  return out;
}
