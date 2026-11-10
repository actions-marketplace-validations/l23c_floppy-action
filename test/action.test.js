import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/index.js";
import { setWriter } from "../src/core.js";
import { fakeServer, workspace, outputs, pr } from "./helpers.js";

let srv;
let stdout;
beforeEach(async () => {
  srv = await fakeServer();
  stdout = "";
  setWriter((s) => {
    stdout += s;
  });
});
afterEach(async () => {
  process.exitCode = 0;
  await srv.close();
});

test("drops a file without a key, outputs its link and the claim url, masks secrets", async () => {
  const { env } = workspace({ "report.pdf": "pdf bytes" }, { inputs: { path: "report.pdf" }, base: srv.base });
  const links = await run({ env });
  assert.equal(links.length, 1);
  const drop = srv.calls.find((c) => c.path.startsWith("/api/drop/"));
  assert.equal(drop.method, "PUT");
  assert.equal(drop.path, "/api/drop/report.pdf");
  assert.equal(drop.headers.authorization, undefined);
  assert.equal(drop.headers["content-length"], "9");
  assert.match(drop.headers["user-agent"], /^floppy-action\//);
  const out = outputs(env);
  assert.equal(out.url, "https://fpy.sh/s1");
  assert.deepEqual(JSON.parse(out.urls), ["https://fpy.sh/s1"]);
  assert.equal(out["claim-url"], "https://fpy.sh/claim/abc");
  assert.match(stdout, /::add-mask::fpy_live_agent/);
  assert.match(stdout, /::add-mask::https:\/\/fpy.sh\/claim\/abc/);
  assert.match(stdout, /::warning::Uploaded without an account/);
});

test("reuses the agent key from the first drop for every later file", async () => {
  const { env } = workspace({ "a.txt": "a", "b.txt": "bb", "c.md": "ccc" }, { inputs: { path: "*.txt\n*.md" }, base: srv.base });
  await run({ env });
  const drops = srv.calls.filter((c) => c.path.startsWith("/api/drop/"));
  assert.equal(drops.length, 3);
  assert.equal(drops[0].headers.authorization, undefined);
  assert.equal(drops[1].headers.authorization, "Bearer fpy_live_agent");
  assert.equal(drops[2].headers.authorization, "Bearer fpy_live_agent");
  // outputs stay in path order
  const out = JSON.parse(outputs(env).links);
  assert.deepEqual(out.map((l) => l.name), ["a.txt", "b.txt", "c.md"]);
});

test("sends the api key, label and expiry", async () => {
  const { env } = workspace({ "deck.pdf": "x" }, { inputs: { path: "deck.pdf", "api-key": "fpy_live_mine", label: "Design review", expiry: "1w" }, base: srv.base });
  await run({ env });
  const drop = srv.calls.find((c) => c.path.startsWith("/api/drop/"));
  assert.equal(drop.headers.authorization, "Bearer fpy_live_mine");
  assert.deepEqual(drop.query, { label: "Design review", expiry: "1W" });
  assert.equal(outputs(env).url, "https://fpy.sh/r1");
  assert.equal(outputs(env)["claim-url"], "");
  assert.match(stdout, /::add-mask::fpy_live_mine/);
  assert.doesNotMatch(stdout, /Uploaded without an account/);
});

test("uses multipart above the drop limit, retries a failed part, then sets expiry and label", async () => {
  const { env } = workspace({ "big.mov": 25 }, { inputs: { path: "big.mov", "api-key": "fpy_live_mine", label: "Jane", expiry: "1W" }, base: srv.base });
  await run({ env, maxDrop: 20, retryDelayMs: 1 });
  const seq = srv.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(seq, [
    "POST /api/v1/links",
    "PUT /api/v1/files/fm1/parts/1",
    "PUT /api/v1/files/fm1/parts/2",
    "PUT /api/v1/files/fm1/parts/2",
    "PUT /api/v1/files/fm1/parts/3",
    "POST /api/v1/files/fm1/complete",
    "PATCH /api/v1/links/m1",
    "POST /api/v1/links/m1/shares",
  ]);
  assert.deepEqual(JSON.parse(srv.calls[0].body), { files: [{ name: "big.mov", size: 25 }] });
  assert.deepEqual(srv.calls.filter((c) => c.path.includes("/parts/")).map((c) => c.size), [10, 10, 10, 5]);
  assert.deepEqual(JSON.parse(srv.calls[5].body), { parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: `"e${n}"` })) });
  assert.deepEqual(JSON.parse(srv.calls[6].body), { expiry: "1W" });
  assert.deepEqual(JSON.parse(srv.calls[7].body), { label: "Jane" });
  const [link] = JSON.parse(outputs(env).links);
  assert.equal(link.url, "https://fpy.sh/label-m1");
  assert.equal(link.expires_at, "2026-11-17T12:00:00.000Z");
});

test("a big file without a key reuses the agent key of a smaller file uploaded first", async () => {
  const { env } = workspace({ "a-big.bin": 25, "z-small.txt": "s" }, { inputs: { path: "*" }, base: srv.base });
  await run({ env, maxDrop: 20, retryDelayMs: 1 });
  assert.equal(srv.calls[0].path, "/api/drop/z-small.txt");
  const create = srv.calls.find((c) => c.path === "/api/v1/links");
  assert.equal(create.headers.authorization, "Bearer fpy_live_agent");
  assert.deepEqual(JSON.parse(outputs(env).urls), ["https://fpy.sh/big2", "https://fpy.sh/s1"]);
});

test("a big file without any key fails with a pointer to api-key, after uploading the rest", async () => {
  const { env } = workspace({ "big.bin": 25 }, { inputs: { path: "big.bin" }, base: srv.base });
  await assert.rejects(run({ env, maxDrop: 20 }), /1 of 1 file\(s\) failed/);
  assert.match(stdout, /over 100 MB.*api-key/);
});

test("retries a 429 from the drop", async () => {
  await srv.close();
  srv = await fakeServer({ dropStatus: [429] });
  const { env } = workspace({ "a.txt": "a" }, { inputs: { path: "a.txt" }, base: srv.base });
  await run({ env });
  assert.equal(srv.calls.filter((c) => c.path === "/api/drop/a.txt").length, 2);
});

test("surfaces Floppy's error message and next step", async () => {
  const { env } = workspace({ "a.txt": "a" }, { inputs: { path: "a.txt", "api-url": `${srv.base}/nope` }, base: srv.base });
  await assert.rejects(run({ env }), /failed to upload/);
  assert.match(stdout, /No route PUT/);
});

test("comments on a pull request, then updates the same comment on the next run", async () => {
  const event = pr();
  const ws = workspace({ "out/report.pdf": "r", "out/shot.png": "p" }, { inputs: { path: "out/" }, event, base: srv.base });
  await run({ env: ws.env });
  assert.equal(srv.state.comments.length, 1);
  const body = srv.state.comments[0].body;
  assert.ok(body.startsWith("<!-- floppy-action:CI/preview -->"));
  assert.match(body, /\*\*2 files on Floppy\*\* for feedfac/);
  assert.match(body, /- \[`report.pdf`\]\(https:\/\/fpy.sh\/s\d\)/);
  assert.match(body, /- \[`shot.png`\]\(https:\/\/fpy.sh\/s\d\)/);
  assert.match(body, /stop working after 72 hours/);
  assert.doesNotMatch(body, /claim\/abc/, "the claim link must never be in a comment");
  assert.match(body, /<sub>Shared with \[Floppy\]\(https:\/\/fpy.sh\/agents\) · \[run\]\(https:\/\/github.com\/acme\/app\/actions\/runs\/42\)<\/sub>$/);
  const post = srv.calls.find((c) => c.method === "POST" && c.path.endsWith("/comments"));
  assert.equal(post.path, "/repos/acme/app/issues/7/comments");
  assert.equal(post.headers.authorization, "Bearer ghs_test");

  await run({ env: ws.env });
  assert.equal(srv.state.comments.length, 1, "second run edits instead of posting again");
  assert.ok(srv.calls.some((c) => c.method === "PATCH" && c.path === "/repos/acme/app/issues/comments/100"));
});

test("doesn't touch another job's comment", async () => {
  await srv.close();
  srv = await fakeServer({ comments: [{ id: 5, body: "<!-- floppy-action:CI/other -->\nold" }] });
  const { env } = workspace({ "a.txt": "a" }, { inputs: { path: "a.txt", "api-key": "fpy_live_mine" }, event: pr(), base: srv.base });
  await run({ env });
  assert.equal(srv.state.comments.length, 2);
  assert.equal(srv.state.comments[0].body, "<!-- floppy-action:CI/other -->\nold");
  assert.doesNotMatch(srv.state.comments[1].body, /72 hours/);
});

test("no comment on push events unless asked, and comment: false wins on PRs", async () => {
  const push = workspace({ "a.txt": "a" }, { inputs: { path: "a.txt" }, event: { repository: {} }, base: srv.base });
  await run({ env: push.env });
  const off = workspace({ "a.txt": "a" }, { inputs: { path: "a.txt", comment: "false" }, event: pr(), base: srv.base });
  await run({ env: off.env });
  assert.equal(srv.calls.filter((c) => c.path.includes("/comments")).length, 0);
});

test("a comment failure (fork PR) is a warning, not a failure", async () => {
  const { env } = workspace({ "a.txt": "a" }, { inputs: { path: "a.txt" }, event: pr(), base: srv.base });
  env.GITHUB_API_URL = `${srv.base}/denied`;
  await run({ env });
  assert.match(stdout, /::warning::Couldn't comment on the pull request/);
  assert.equal(process.exitCode ?? 0, 0);
});

test("job summary shows the claim link only on private repositories", async () => {
  const pub = workspace({ "a.txt": "a" }, { inputs: { path: "a.txt", comment: "false" }, event: pr(), base: srv.base });
  await run({ env: pub.env });
  const pubSummary = readFileSync(pub.env.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(pubSummary, /\| `a.txt` \| https:\/\/fpy.sh\/s1 \| scanning \| 2026-11-13 \|/);
  assert.doesNotMatch(pubSummary, /claim\/abc/);

  const priv = workspace({ "a.txt": "a" }, { inputs: { path: "a.txt", comment: "false" }, event: pr({ repository: { private: true } }), base: srv.base });
  await run({ env: priv.env });
  assert.match(readFileSync(priv.env.GITHUB_STEP_SUMMARY, "utf8"), /\[claim them\]\(https:\/\/fpy.sh\/claim\/abc\)/);
});

test("if-no-files-found", async () => {
  const err = workspace({}, { inputs: { path: "missing/*.pdf" }, base: srv.base });
  await assert.rejects(run({ env: err.env }), /No files matched missing\/\*\.pdf/);
  const warn = workspace({}, { inputs: { path: "missing/*.pdf", "if-no-files-found": "warn" }, base: srv.base });
  assert.deepEqual(await run({ env: warn.env }), []);
  assert.match(stdout, /::warning::No files matched/);
});

test("rejects bad inputs before uploading", async () => {
  const { env } = workspace({ "a.txt": "a" }, { inputs: { path: "a.txt", expiry: "forever" }, base: srv.base });
  await assert.rejects(run({ env }), /expiry must be one of/);
  assert.equal(srv.calls.length, 0);
});

test("empty files are reported, not sent", async () => {
  const { env } = workspace({ "empty.txt": "" }, { inputs: { path: "empty.txt" }, base: srv.base });
  await assert.rejects(run({ env }), /failed to upload/);
  assert.match(stdout, /empty\.txt is empty/);
  assert.equal(srv.calls.length, 0);
});
