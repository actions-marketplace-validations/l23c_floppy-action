// Markdown for the PR comment and the job summary.

export const MAX_LISTED = 50;

export function marker(key) {
  return `<!-- floppy-action:${key} -->`;
}

const code = (name) => `\`${String(name).replace(/`/g, "'").replace(/\r?\n/g, " ")}\``;

function list(links, max = MAX_LISTED) {
  const lines = links.slice(0, max).map((l) => `- [${code(l.name)}](${l.url})`);
  if (links.length > max) lines.push(`- …and ${links.length - max} more in the workflow run summary`);
  return lines.join("\n");
}

/**
 * @param {{ links: Array<{ name: string, url: string }>, key: string, sha?: string, unclaimed?: boolean, runUrl?: string }} o
 */
export function renderComment({ links, key, sha, unclaimed, runUrl }) {
  const files = links.length === 1 ? "1 file" : `${links.length} files`;
  const commit = sha ? ` for ${sha.slice(0, 7)}` : "";
  const out = [marker(key), `**${files} on Floppy**${commit}`, "", list(links), ""];
  if (unclaimed) {
    out.push(
      "Uploaded without an account, so these links stop working after 72 hours. Pass a Floppy API key as `api-key` to keep them.",
      "",
    );
  }
  const run = runUrl ? ` · [run](${runUrl})` : "";
  out.push(`<sub>Shared with [Floppy](https://fpy.sh/agents)${run}</sub>`);
  return out.join("\n");
}

/** Job summary. The claim link is only shown on private repositories: whoever opens it first gets the files. */
export function renderSummary({ links, claimUrl, showClaim }) {
  const rows = links.map((l) => `| ${code(l.name)} | ${l.url} | ${l.scan ?? ""} | ${l.expires_at ? l.expires_at.slice(0, 10) : ""} |`);
  const out = ["### Floppy", "", "| File | Link | Scan | Expires |", "|---|---|---|---|", ...rows, ""];
  if (claimUrl) {
    out.push(
      showClaim
        ? `Unclaimed upload. Keep the files and see who opens them: [claim them](${claimUrl}) within 72 hours.`
        : "Unclaimed upload, deleted after 72 hours. The claim link is in the `claim-url` output (not printed on public repositories).",
      "",
    );
  }
  return out.join("\n");
}
