/**
 * Where to run a re-run from: the project's Python environment, and the user's shell.
 *
 * A command typed in a VS Code terminal runs with that terminal's activated virtual environment and in its
 * shell (often PowerShell on Windows). The extension host has neither, so Deep trace puts the project's
 * environment first on PATH and runs the command through the same shell.
 */
import * as fs from "fs";
import * as path from "path";

export interface PyEnv {
  /** Folder with the interpreter and console scripts (bin/ or Scripts/). */
  binDir: string;
  /** Root of the environment (VIRTUAL_ENV), when it is a venv. */
  prefix?: string;
  /** Where it came from, for messages: "VS Code's selected interpreter", ".venv", … */
  source: string;
}

const WIN = process.platform === "win32";
const VENV_DIRS = [".venv", "venv", "env", ".env"];

/** A virtual environment inside the project folder (`.venv`, `venv`, `env`, `.env`), if there is one. */
export function findProjectVenv(root: string): PyEnv | undefined {
  for (const d of VENV_DIRS) {
    const prefix = path.join(root, d);
    const bin = path.join(prefix, WIN ? "Scripts" : "bin");
    if (fs.existsSync(path.join(prefix, "pyvenv.cfg")) && fs.existsSync(path.join(bin, WIN ? "python.exe" : "python"))) return { binDir: bin, prefix, source: d };
  }
  return undefined;
}

/** The environment of a given interpreter executable (for VS Code's selected interpreter). */
export function envOfInterpreter(python: string, source: string): PyEnv | undefined {
  if (!python || !fs.existsSync(python)) return undefined;
  const binDir = path.dirname(python);
  const prefix = path.dirname(binDir);
  return { binDir, prefix: fs.existsSync(path.join(prefix, "pyvenv.cfg")) ? prefix : undefined, source };
}

/** `env` with the environment first on PATH (and VIRTUAL_ENV set), keeping Windows' "Path" spelling. */
export function withPyEnv(env: NodeJS.ProcessEnv, py: PyEnv | undefined): NodeJS.ProcessEnv {
  if (!py) return env;
  const out = { ...env };
  const key = Object.keys(out).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  out[key] = [py.binDir, out[key]].filter(Boolean).join(path.delimiter);
  if (py.prefix) out.VIRTUAL_ENV = py.prefix;
  delete out.PYTHONHOME;
  return out;
}

export interface ShellRun { file: string; args: string[]; shell?: boolean | string; label: string }

/**
 * How to run `command` the way the user's terminal would. PowerShell gets the command base64-encoded
 * (-EncodedCommand), so quotes and `$` survive, and passes the last native exit code on. Unknown shells
 * fall back to the platform default (cmd.exe / /bin/sh).
 */
export function shellRun(command: string, shellPath?: string): ShellRun {
  const base = shellPath ? path.basename(shellPath).toLowerCase().replace(/\.exe$/, "") : "";
  if (base === "pwsh" || base === "powershell") {
    const script = `${command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`;
    return { file: shellPath!, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], label: base };
  }
  if (["bash", "zsh", "sh", "fish", "dash", "ksh"].includes(base)) return { file: shellPath!, args: ["-c", command], label: base };
  if (base === "cmd") return { file: command, args: [], shell: shellPath, label: "cmd" };
  return { file: command, args: [], shell: true, label: WIN ? "cmd" : "sh" };
}
