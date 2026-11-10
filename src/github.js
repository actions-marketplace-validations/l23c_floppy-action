// Create or update this job's comment on a pull request (one per workflow + job).
import { marker } from "./comment.js";

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function upsertComment({ apiUrl = "https://api.github.com", token, repo, issue, key, body, fetch = globalThis.fetch }) {
  const base = `${apiUrl.replace(/\/+$/, "")}/repos/${repo}/issues`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "floppy-action",
    "x-github-api-version": "2022-11-28",
  };
  const call = async (method, url, payload) => {
    const res = await fetch(url, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GitHubError(`GitHub ${method} ${new URL(url).pathname} failed with ${res.status}: ${data.message ?? ""}`.trim(), res.status);
    return data;
  };

  const tag = marker(key);
  let existing = null;
  for (let page = 1; page <= 10 && !existing; page++) {
    const comments = await call("GET", `${base}/${issue}/comments?per_page=100&page=${page}`);
    existing = comments.find((c) => typeof c.body === "string" && c.body.startsWith(tag)) ?? null;
    if (comments.length < 100) break;
  }
  if (existing) return { ...(await call("PATCH", `${base}/comments/${existing.id}`, { body })), updated: true };
  return { ...(await call("POST", `${base}/${issue}/comments`, { body })), updated: false };
}
