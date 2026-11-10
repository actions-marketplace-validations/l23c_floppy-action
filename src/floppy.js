// Floppy upload client. Files up to 100 MB go through the one-call drop
// (PUT /api/drop/:name); bigger files use the multipart REST flow, which needs a key.
import { open } from "node:fs/promises";

export const MAX_DROP = 100 * 1000 * 1000;
const VERSION = "1.0.0";

export class FloppyError extends Error {
  constructor(message, { status, code, next } = {}) {
    super(next ? `${message} ${next}` : message);
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Floppy {
  /**
   * @param {{ baseUrl?: string, apiKey?: string, fetch?: typeof fetch, onSecret?: (s: string) => void,
   *   log?: (s: string) => void, maxDrop?: number, retryDelayMs?: number }} opts
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || "https://fpy.sh").replace(/\/+$/, "");
    this.apiKey = opts.apiKey || "";
    this.fetch = opts.fetch || globalThis.fetch;
    this.onSecret = opts.onSecret || (() => {});
    this.log = opts.log || (() => {});
    this.maxDrop = opts.maxDrop ?? MAX_DROP;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
    /** Set once an upload lands in an unclaimed account. */
    this.claimUrl = "";
    /** True when this run created the account (no api-key was given). */
    this.createdAccount = false;
  }

  headers(extra = {}) {
    const h = { "user-agent": `floppy-action/${VERSION}`, ...extra };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /** fetch with retries on 429 (honouring Retry-After) and, when idempotent, on 5xx and network errors. */
  async request(method, path, { body, headers, idempotent = false, attempts = 4 } = {}) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await this.fetch(`${this.baseUrl}${path}`, { method, body, headers: this.headers(headers) });
      } catch (e) {
        if (idempotent && attempt < attempts) {
          await sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw new FloppyError(`Couldn't reach ${this.baseUrl}: ${e.message}`);
      }
      if (res.ok) return res.status === 204 ? {} : res.json();
      const data = await res.json().catch(() => ({}));
      const retryable = res.status === 429 || (idempotent && res.status >= 500);
      if (retryable && attempt < attempts) {
        const after = Number(res.headers.get("retry-after") ?? data?.error?.retry_after);
        const wait = Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : this.retryDelayMs * attempt;
        this.log(`Floppy said ${res.status}; retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      const err = data?.error;
      if (typeof err === "object" && err) {
        if (err.claim_url) this.noteClaimUrl(err.claim_url);
        throw new FloppyError(err.message || `HTTP ${res.status}`, { status: res.status, code: err.code, next: err.next });
      }
      throw new FloppyError(typeof err === "string" ? err : `Floppy returned HTTP ${res.status} for ${method} ${path}`, { status: res.status });
    }
  }

  noteClaimUrl(url) {
    if (!url || this.claimUrl === url) return;
    this.onSecret(url);
    this.claimUrl = url;
  }

  /**
   * Upload one file. Returns { name, url, id, scan, expires_at }.
   * @param {{ path: string, name: string, size: number }} file
   * @param {{ label?: string, expiry?: string }} opts
   */
  async upload(file, opts = {}) {
    if (file.size === 0) throw new FloppyError(`${file.name} is empty; Floppy needs at least one byte.`);
    if (file.size <= this.maxDrop) return this.drop(file, opts);
    if (!this.apiKey) {
      throw new FloppyError(
        `${file.name} is over 100 MB, which needs the multipart upload and so an api-key.`,
        { next: "Create a key at https://fpy.sh/app/keys, save it as a repository secret and pass it as api-key." },
      );
    }
    return this.multipart(file, opts);
  }

  async drop(file, { label, expiry } = {}) {
    const q = new URLSearchParams();
    if (label) q.set("label", label);
    if (expiry) q.set("expiry", expiry);
    const qs = q.toString() ? `?${q}` : "";
    const fh = await open(file.path, "r");
    let bytes;
    try {
      bytes = await fh.readFile();
    } finally {
      await fh.close();
    }
    const data = await this.request("PUT", `/api/drop/${encodeURIComponent(file.name)}${qs}`, {
      body: bytes,
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
    });
    if (data.agent_key && !this.apiKey) {
      // A new unclaimed account: keep using it so every file of this run lands together.
      this.onSecret(data.agent_key);
      this.apiKey = data.agent_key;
      this.createdAccount = true;
    }
    if (data.claim_url) this.noteClaimUrl(data.claim_url);
    return {
      name: file.name,
      url: data.share_url || data.link?.url,
      id: data.link?.id,
      scan: data.scan || data.link?.scan,
      expires_at: data.link?.expires_at ?? null,
    };
  }

  async multipart(file, { label, expiry } = {}) {
    const json = { "content-type": "application/json" };
    const plan = await this.request("POST", "/api/v1/links", {
      body: JSON.stringify({ files: [{ name: file.name, size: file.size }] }),
      headers: json,
    });
    const link = plan.link;
    const up = plan.uploads?.[0];
    if (!link?.id || !up?.fileId) throw new FloppyError("Floppy returned an upload plan without a file.");
    const parts = [];
    const fh = await open(file.path, "r");
    try {
      for (let n = 1; n <= up.parts; n++) {
        const start = (n - 1) * up.partSize;
        const len = Math.min(up.partSize, file.size - start);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, start);
        if (bytesRead !== len) throw new FloppyError(`${file.name} changed while it was being uploaded.`);
        const r = await this.request("PUT", `/api/v1/files/${encodeURIComponent(up.fileId)}/parts/${n}`, {
          body: buf,
          headers: { "content-type": "application/octet-stream", "content-length": String(len) },
          idempotent: true,
        });
        parts.push({ partNumber: n, etag: r.etag });
        this.log(`  ${file.name}: part ${n}/${up.parts}`);
      }
    } finally {
      await fh.close();
    }
    const done = await this.request("POST", `/api/v1/files/${encodeURIComponent(up.fileId)}/complete`, {
      body: JSON.stringify({ parts }),
      headers: json,
    });
    let expiresAt = link.expires_at ?? null;
    if (expiry) {
      const patched = await this.request("PATCH", `/api/v1/links/${encodeURIComponent(link.id)}`, {
        body: JSON.stringify({ expiry }),
        headers: json,
      });
      expiresAt = patched.expires_at ?? expiresAt;
    }
    let url = link.url;
    if (label) {
      const share = await this.request("POST", `/api/v1/links/${encodeURIComponent(link.id)}/shares`, {
        body: JSON.stringify({ label }),
        headers: json,
      });
      url = share.url || url;
    }
    return { name: file.name, url, id: link.id, scan: done.scan || "scanning", expires_at: expiresAt };
  }
}
