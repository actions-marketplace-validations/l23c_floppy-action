import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expand, globToRegExp } from "../src/glob.js";

function tree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "floppy-glob-"));
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), "x");
  }
  return dir;
}

const rel = (dir, list) => list.map((f) => path.relative(dir, f).split(path.sep).join("/"));

test("globToRegExp", () => {
  assert.ok(globToRegExp("*.pdf").test("a.pdf"));
  assert.ok(!globToRegExp("*.pdf").test("dir/a.pdf"));
  assert.ok(globToRegExp("**/*.pdf").test("a.pdf"));
  assert.ok(globToRegExp("**/*.pdf").test("x/y/a.pdf"));
  assert.ok(globToRegExp("docs/**").test("docs/a/b.md"));
  assert.ok(globToRegExp("*.{png,jpg}").test("a.jpg"));
  assert.ok(!globToRegExp("*.{png,jpg}").test("a.gif"));
  assert.ok(globToRegExp("v?.txt").test("v1.txt"));
  assert.ok(globToRegExp("[ab].txt").test("b.txt"));
  assert.ok(!globToRegExp("[!ab].txt").test("a.txt"));
  assert.ok(globToRegExp("a+b (1).txt").test("a+b (1).txt"));
});

test("expand: files, dirs, globs, exclusions, no .git", () => {
  const dir = tree(["report.pdf", "out/a.png", "out/b.jpg", "out/sub/c.png", ".git/config", ".env", "out/.secret", "docs/x.md", "docs/draft.md"]);
  assert.deepEqual(rel(dir, expand(["report.pdf"], dir)), ["report.pdf"]);
  assert.deepEqual(rel(dir, expand(["out"], dir)), ["out/a.png", "out/b.jpg", "out/sub/c.png"]);
  assert.deepEqual(rel(dir, expand(["out/*.png"], dir)), ["out/a.png"]);
  assert.deepEqual(rel(dir, expand(["**/*.png"], dir)), ["out/a.png", "out/sub/c.png"]);
  assert.deepEqual(rel(dir, expand(["out/**/*.{png,jpg}", "!out/sub"], dir)), ["out/a.png", "out/b.jpg"]);
  assert.deepEqual(rel(dir, expand(["docs/*.md", "!**/draft.md"], dir)), ["docs/x.md"]);
  assert.deepEqual(rel(dir, expand(["**"], dir)).filter((f) => f.startsWith(".git")), []);
  assert.deepEqual(rel(dir, expand(["*"], dir)), ["report.pdf"], "hidden files skipped");
  assert.deepEqual(rel(dir, expand([".env", "out/.*"], dir)), [".env", "out/.secret"], "unless named");
  assert.deepEqual(expand(["nope.pdf", "nope/*"], dir), []);
  assert.deepEqual(rel(dir, expand(["report.pdf", "*.pdf"], dir)), ["report.pdf"], "de-duplicated");
  assert.deepEqual(rel(dir, expand([path.join(dir, "out", "*.jpg")], "/")), ["out/b.jpg"], "absolute patterns");
});
