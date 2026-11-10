// A fake Floppy + GitHub API on one local HTTP server, recording every request.
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export async function fakeServer({ dropStatus = [], comments = [] } = {}) {
  const calls = [];
  const state = { links: 0, comments: [...comments], nextCommentId: 100, parts: {} };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, size: body.length, body });
    const json = (status, data, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    let m;
    if (req.method === "PUT" && (m = url.pathname.match(/^\/api\/drop\/(.+)$/))) {
      const forced = dropStatus.shift();
      if (forced) return json(forced, { error: { code: "slow_down", message: "Too many", retry_after: 0 } }, { "retry-after": "0" });
      const id = `l${++state.links}`;
      const auth = req.headers.authorization;
      const fresh = !auth;
      const name = decodeURIComponent(m[1]);
      return json(201, {
        link: { id, name, url: `https://fpy.sh/s${state.links}`, expires_at: "2026-11-13T12:00:00.000Z", scan: "scanning" },
        share: url.searchParams.get("label") ? { url: `https://fpy.sh/r${state.links}` } : null,
        share_url: url.searchParams.get("label") ? `https://fpy.sh/r${state.links}` : `https://fpy.sh/s${state.links}`,
        scan: "scanning",
        ...(fresh ? { agent_key: "fpy_live_agent", claim_url: "https://fpy.sh/claim/abc" } : auth === "Bearer fpy_live_agent" ? { claim_url: "https://fpy.sh/claim/abc" } : {}),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/links") {
      if (!req.headers.authorization) return json(401, { error: { code: "unauthorized", message: "Missing key" } });
      const { files } = JSON.parse(body);
      const id = `m${++state.links}`;
      const partSize = 10;
      return json(201, {
        link: { id, name: files[0].name, url: `https://fpy.sh/big${state.links}`, expires_at: "2026-11-13T12:00:00.000Z" },
        uploads: [{ fileId: `f${id}`, partSize, parts: Math.ceil(files[0].size / partSize) }],
        next: "…",
      });
    }
    if (req.method === "PUT" && (m = url.pathname.match(/^\/api\/v1\/files\/([^/]+)\/parts\/(\d+)$/))) {
      const k = `${m[1]}:${m[2]}`;
      state.parts[k] = (state.parts[k] ?? 0) + 1;
      if (m[2] === "2" && state.parts[k] === 1) return json(503, { error: "busy" }); // one transient failure
      return json(200, { partNumber: Number(m[2]), etag: `"e${m[2]}"` });
    }
    if (req.method === "POST" && url.pathname.match(/^\/api\/v1\/files\/[^/]+\/complete$/)) return json(200, { ok: true, linkReady: true, scan: "scanning" });
    if (req.method === "PATCH" && (m = url.pathname.match(/^\/api\/v1\/links\/([^/]+)$/))) return json(200, { id: m[1], expires_at: "2026-11-17T12:00:00.000Z" });
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/v1\/links\/([^/]+)\/shares$/))) return json(201, { id: "sh1", url: `https://fpy.sh/label-${m[1]}` });
    // GitHub
    if ((m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/))) {
      if (req.method === "GET") return json(200, state.comments);
      const c = { id: state.nextCommentId++, body: JSON.parse(body).body, html_url: "https://github.com/c" };
      state.comments.push(c);
      return json(201, c);
    }
    if (req.method === "PATCH" && (m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/))) {
      const c = state.comments.find((x) => x.id === Number(m[1]));
      c.body = JSON.parse(body).body;
      return json(200, c);
    }
    json(404, { error: { code: "not_found", message: `No route ${req.method} ${url.pathname}` } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, state, close: () => new Promise((r) => server.close(r)) };
}

/** A temp workspace with files ({ "a/b.txt": "content" | number-of-bytes }) plus an env for the action. */
export function workspace(files, { inputs = {}, event = null, base } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "floppy-action-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "number" ? Buffer.alloc(content, 97) : content);
  }
  const env = {
    GITHUB_WORKSPACE: dir,
    GITHUB_OUTPUT: path.join(dir, ".out"),
    GITHUB_STEP_SUMMARY: path.join(dir, ".summary"),
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_WORKFLOW: "CI",
    GITHUB_JOB: "preview",
    GITHUB_RUN_ID: "42",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_SHA: "0123456789abcdef",
    GITHUB_API_URL: base,
    "INPUT_API-URL": base,
    "INPUT_GITHUB-TOKEN": "ghs_test",
    INPUT_COMMENT: "auto",
    "INPUT_IF-NO-FILES-FOUND": "error",
  };
  writeFileSync(env.GITHUB_OUTPUT, "");
  writeFileSync(env.GITHUB_STEP_SUMMARY, "");
  if (event) {
    env.GITHUB_EVENT_PATH = path.join(dir, ".event.json");
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  }
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return { dir, env };
}

export function outputs(env) {
  const text = readFileSync(env.GITHUB_OUTPUT, "utf8");
  const out = {};
  const re = /^(.+?)<<(ghadelimiter_[\w-]+)\r?\n([\s\S]*?)\r?\n\2$/gm;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[3];
  return out;
}

export const pr = (extra = {}) => ({ pull_request: { number: 7, head: { sha: "feedfacecafebeef" } }, repository: { private: false }, ...extra });
