// Minimal glob: *, **, ?, [abc], {a,b}. Lines starting with ! exclude. A directory means
// every file under it. Paths are resolved against the workspace; .git is never walked, and
// hidden files (.env, .npmrc…) only match when the pattern names a dot path itself.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const MAGIC = /[*?[{]/;

export function globToRegExp(pattern) {
  let re = "";
  let inBrace = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const atStart = i === 0 || pattern[i - 1] === "/";
        i++;
        if (pattern[i + 1] === "/" && atStart) {
          i++;
          re += "(?:[^/]*/)*"; // "**/" = zero or more directories
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        let body = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        re += `[${body}]`;
        i = end;
      }
    } else if (c === "{") {
      inBrace++;
      re += "(?:";
    } else if (c === "}" && inBrace) {
      inBrace--;
      re += ")";
    } else if (c === "," && inBrace) re += "|";
    else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function walk(dir, out, hidden) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === ".git" || (!hidden && e.name.startsWith("."))) continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const s = statSync(full);
        isDir = false; // don't follow directory links (no cycles)
        isFile = s.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) walk(full, out, hidden);
    else if (isFile) out.push(full);
  }
}

/** Absolute paths of the files one pattern matches. */
function matchOne(pattern, cwd) {
  const abs = path.resolve(cwd, pattern);
  if (!MAGIC.test(pattern)) {
    let s;
    try {
      s = statSync(abs);
    } catch {
      return [];
    }
    if (s.isFile()) return [abs];
    if (s.isDirectory()) {
      const out = [];
      walk(abs, out, false);
      return out;
    }
    return [];
  }
  const parts = toPosix(abs).split("/");
  const firstMagic = parts.findIndex((p) => MAGIC.test(p));
  const base = parts.slice(0, firstMagic).join("/") || "/";
  const re = globToRegExp(toPosix(abs));
  const out = [];
  walk(base, out, /(^|\/)\./.test(toPosix(pattern)));
  return out.filter((f) => re.test(toPosix(f)));
}

/** Expand input lines into a sorted, de-duplicated list of absolute file paths. */
export function expand(lines, cwd = process.cwd()) {
  const include = new Set();
  const excludes = [];
  for (const line of lines) {
    if (line.startsWith("!")) excludes.push(line.slice(1).trim());
    else for (const f of matchOne(line, cwd)) include.add(f);
  }
  let files = [...include];
  for (const ex of excludes) {
    const abs = toPosix(path.resolve(cwd, ex));
    const re = MAGIC.test(ex) ? globToRegExp(abs) : null;
    files = files.filter((f) => {
      const p = toPosix(f);
      return re ? !re.test(p) : p !== abs && !p.startsWith(`${abs}/`);
    });
  }
  return files.sort();
}
