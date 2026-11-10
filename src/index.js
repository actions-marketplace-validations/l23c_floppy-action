import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "./core.js";
import { expand } from "./glob.js";
import { Floppy } from "./floppy.js";
import { renderComment, renderSummary } from "./comment.js";
import { upsertComment } from "./github.js";

const EXPIRIES = ["1D", "2D", "3D", "5D", "1W", "2W", "1M", "3M", "NEVER"];

function readEvent(env) {
  if (!env.GITHUB_EVENT_PATH) return {};
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return {};
  }
}

function prNumber(event) {
  if (event.pull_request?.number) return event.pull_request.number;
  if (event.issue?.pull_request && event.issue.number) return event.issue.number;
  return null;
}

function parseBool(value, name) {
  const v = value.toLowerCase();
  if (["true", "yes", "1", "on"].includes(v)) return true;
  if (["false", "no", "0", "off"].includes(v)) return false;
  throw new Error(`${name} must be true, false or auto (got "${value}").`);
}

/** Run the action. Returns the uploaded links (for tests). */
export async function run({ env = process.env, fetch = globalThis.fetch, retryDelayMs, maxDrop } = {}) {
  const patterns = core.getMultilineInput("path", env);
  if (!patterns.length) throw new Error("path is required.");
  const apiKey = core.getInput("api-key", env);
  const label = core.getInput("label", env);
  const expiryIn = core.getInput("expiry", env).toUpperCase();
  const commentIn = core.getInput("comment", env) || "auto";
  const ifNone = (core.getInput("if-no-files-found", env) || "error").toLowerCase();
  const apiUrl = core.getInput("api-url", env) || "https://fpy.sh";
  const token = core.getInput("github-token", env);

  if (apiKey) core.setSecret(apiKey);
  if (expiryIn && !EXPIRIES.includes(expiryIn)) throw new Error(`expiry must be one of ${EXPIRIES.join(", ")} (got "${expiryIn}").`);
  if (!["error", "warn", "ignore"].includes(ifNone)) throw new Error(`if-no-files-found must be error, warn or ignore (got "${ifNone}").`);
  if (label.length > 80) throw new Error("label can be up to 80 characters.");

  const event = readEvent(env);
  const pr = prNumber(event);
  const wantComment = commentIn.toLowerCase() === "auto" ? Boolean(event.pull_request) : parseBool(commentIn, "comment");

  const cwd = env.GITHUB_WORKSPACE || process.cwd();
  const paths = expand(patterns, cwd);
  if (!paths.length) {
    const msg = `No files matched ${patterns.join(", ")}.`;
    if (ifNone === "error") throw new Error(msg);
    if (ifNone === "warn") core.warning(msg);
    else core.info(msg);
    return [];
  }

  const files = paths.map((p) => ({ path: p, name: path.basename(p), size: statSync(p).size, rel: path.relative(cwd, p) || p }));
  const floppy = new Floppy({ baseUrl: apiUrl, apiKey, fetch, onSecret: core.setSecret, log: core.info, retryDelayMs, maxDrop });

  // Without a key the first small drop creates the account; bigger files then reuse its key.
  const order = apiKey ? files : [...files].sort((a, b) => a.size - b.size);
  const results = new Map();
  const failures = [];
  for (const f of order) {
    try {
      const r = await floppy.upload(f, { label, expiry: expiryIn });
      results.set(f.path, r);
      core.info(`${f.rel} → ${r.url}`);
    } catch (e) {
      failures.push(`${f.rel}: ${e.message}`);
      core.error(`${f.rel}: ${e.message}`);
    }
  }
  const links = files.filter((f) => results.has(f.path)).map((f) => results.get(f.path));

  core.setOutput("url", links[0]?.url ?? "", env);
  core.setOutput("urls", JSON.stringify(links.map((l) => l.url)), env);
  core.setOutput("links", JSON.stringify(links), env);
  core.setOutput("claim-url", floppy.claimUrl, env);

  if (links.length) {
    const isPrivate = event.repository?.private === true;
    core.summary(renderSummary({ links, claimUrl: floppy.claimUrl, showClaim: isPrivate }), env);
    if (floppy.createdAccount) {
      core.warning("Uploaded without an account: these links stop working after 72 hours. Pass a Floppy API key (https://fpy.sh/app/keys) as api-key to keep them.");
    }
  }

  if (wantComment && links.length) {
    if (!pr) core.warning("comment is on, but this run isn't for a pull request; skipping the comment.");
    else if (!token) core.warning("No github-token, so the links weren't commented on the pull request.");
    else {
      const key = `${env.GITHUB_WORKFLOW ?? "workflow"}/${env.GITHUB_JOB ?? "job"}`.replace(/--+>?/g, "-");
      const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
      const body = renderComment({
        links,
        key,
        sha: event.pull_request?.head?.sha ?? env.GITHUB_SHA,
        unclaimed: Boolean(floppy.claimUrl),
        runUrl,
      });
      try {
        const c = await upsertComment({ apiUrl: env.GITHUB_API_URL, token, repo: env.GITHUB_REPOSITORY, issue: pr, key, body, fetch });
        core.info(`${c.updated ? "Updated" : "Posted"} the comment: ${c.html_url ?? ""}`);
      } catch (e) {
        const hint = e.status === 403 || e.status === 404
          ? " Give the job `permissions: pull-requests: write`. Pull requests from forks get a read-only token, so they can't be commented on from pull_request."
          : "";
        core.warning(`Couldn't comment on the pull request: ${e.message}.${hint}`);
      }
    }
  }

  if (failures.length) throw new Error(`${failures.length} of ${files.length} file(s) failed to upload.`);
  return links;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  run().catch((e) => core.setFailed(e.message));
}
