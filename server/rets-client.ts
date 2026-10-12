// Minimal RETS 1.x client for Pillar 9's Matrix server.
//
// Why we wrote this from scratch:
//   - The popular `rets-client` npm package is unmaintained and pulls in CJS-only
//     deps that don't play nicely with our ESM/tsx build.
//   - We only need three operations: Login, Search (with Digest auth + session
//     cookies), and GetObject (photos). Everything else can wait.
//
// Pillar 9 specifics:
//   - Login URL: https://matrixrets.pillarnine.com/rets/login.ashx
//   - Auth: HTTP Digest (qop=auth)
//   - Format: COMPACT-DECODED (pipe-delimited rows with a header row)
//   - Resource: Property, Class: RE_1 (residential)
//
// The RETS spec is old (1999-era) but stable. Reference:
//   https://www.reso.org/data-dictionary-1.5/
//
// Everything in here is best-effort: if the server returns something we don't
// expect, we throw a typed error and let the caller decide whether to fall
// back to seed data.
import { createHash, randomBytes } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

export interface RetsConfig {
  loginUrl: string;
  username: string;
  password: string;
  userAgent: string;
  uaPassword?: string;
}

interface RetsCapabilities {
  Login: string;
  Logout?: string;
  Search?: string;
  GetObject?: string;
  GetMetadata?: string;
}

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  algorithm?: string;
  opaque?: string;
}

function md5(s: string) {
  return createHash("md5").update(s).digest("hex");
}

function parseChallenge(headerValue: string): DigestChallenge {
  // www-authenticate: Digest realm="...", nonce="...", qop="auth", algorithm="MD5"
  const m = /^Digest\s+(.*)$/i.exec(headerValue);
  if (!m) throw new Error(`Not a Digest challenge: ${headerValue}`);
  const out: any = {};
  // Split on commas not inside quotes
  for (const part of m[1].split(/,\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  if (!out.realm || !out.nonce) throw new Error(`Bad digest challenge: ${headerValue}`);
  return out as DigestChallenge;
}

function buildDigestAuthHeader(
  username: string,
  password: string,
  method: string,
  uri: string,
  challenge: DigestChallenge,
  nc: string,
  cnonce: string,
): string {
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = challenge.qop ?? "auth";
  const response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `algorithm=MD5`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
    `response="${response}"`,
  ];
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

export class RetsAuthError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
    this.name = "RetsAuthError";
  }
}

export class RetsClient {
  private capabilities: RetsCapabilities | null = null;
  private cookies: Map<string, string> = new Map();
  private sessionId: string | null = null;
  private digestChallenge: DigestChallenge | null = null;
  private nonceCounter = 0;
  // CRITICAL: trimValues:false preserves leading/trailing tabs in <COLUMNS> and <DATA>
  // text nodes — Pillar 9 emits tab-delimited rows wrapped in tabs and we need them
  // intact to parse columns correctly.
  private xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: false,
    parseTagValue: false,
  });

  constructor(private cfg: RetsConfig) {}

  private nextNonceCount() {
    this.nonceCounter++;
    return this.nonceCounter.toString(16).padStart(8, "0");
  }

  /** Issue a request with Digest auth + session cookies. */
  private async request(url: string, opts: RequestInit = {}): Promise<Response> {
    const method = (opts.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const requestUri = u.pathname + u.search;
    const headers = new Headers(opts.headers);
    headers.set("User-Agent", this.cfg.userAgent);
    headers.set("RETS-Version", "RETS/1.7.2");
    headers.set("Accept", "*/*");
    if (this.cookies.size) {
      const cookieStr = Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
      headers.set("Cookie", cookieStr);
    }
    // RETS UA password (RETS-UA-Authorization header) — Matrix doesn't usually need this
    if (this.cfg.uaPassword) {
      const a1 = md5(`${this.cfg.userAgent}:${this.cfg.uaPassword}`);
      const sessionId = this.sessionId ?? "";
      const a2 = md5(`${a1}::${sessionId}:RETS/1.7.2`);
      headers.set("RETS-UA-Authorization", `Digest ${a2}`);
    }

    // First attempt: maybe we already have a stored challenge → pre-authenticate
    if (this.digestChallenge) {
      const cnonce = randomBytes(8).toString("hex");
      const nc = this.nextNonceCount();
      headers.set(
        "Authorization",
        buildDigestAuthHeader(
          this.cfg.username,
          this.cfg.password,
          method,
          requestUri,
          this.digestChallenge,
          nc,
          cnonce,
        ),
      );
    }

    let res = await fetch(url, { ...opts, headers, redirect: "manual" });

    // Capture set-cookie
    const setCookieHeaders = (res.headers as any).getSetCookie?.() ?? [];
    for (const sc of setCookieHeaders) {
      const [pair] = sc.split(";");
      const [k, v] = pair.split("=");
      if (k && v !== undefined) this.cookies.set(k.trim(), v.trim());
    }

    // 401 → parse challenge, retry once
    if (res.status === 401) {
      const wa = res.headers.get("www-authenticate");
      if (!wa) throw new RetsAuthError(401, "401 with no www-authenticate header");
      this.digestChallenge = parseChallenge(wa);
      this.nonceCounter = 0;

      const cnonce = randomBytes(8).toString("hex");
      const nc = this.nextNonceCount();
      const headers2 = new Headers(headers);
      headers2.set(
        "Authorization",
        buildDigestAuthHeader(
          this.cfg.username,
          this.cfg.password,
          method,
          requestUri,
          this.digestChallenge,
          nc,
          cnonce,
        ),
      );
      res = await fetch(url, { ...opts, headers: headers2, redirect: "manual" });
      const setCookieHeaders2 = (res.headers as any).getSetCookie?.() ?? [];
      for (const sc of setCookieHeaders2) {
        const [pair] = sc.split(";");
        const [k, v] = pair.split("=");
        if (k && v !== undefined) this.cookies.set(k.trim(), v.trim());
      }
    }

    if (res.status === 401) throw new RetsAuthError(401, "RETS authentication failed (bad username/password?)");
    return res;
  }

  /** RETS Login → fetch capability URLs. Must be called before any other op. */
  async login(): Promise<RetsCapabilities> {
    const res = await this.request(this.cfg.loginUrl);
    const text = await res.text();
    if (!res.ok) throw new RetsAuthError(res.status, `Login failed: ${res.status} ${text.slice(0, 200)}`);
    // Parse <RETS><RETS-RESPONSE>...key=value pairs...</RETS-RESPONSE></RETS>
    const xml = this.xmlParser.parse(text);
    const replyCode = String(xml?.RETS?.["@_ReplyCode"] ?? "0");
    if (replyCode !== "0") {
      throw new RetsAuthError(
        403,
        `RETS Login replied with code ${replyCode}: ${xml?.RETS?.["@_ReplyText"] ?? ""}`,
      );
    }
    const body: string = xml?.RETS?.["RETS-RESPONSE"] ?? "";
    const caps: any = {};
    for (const line of String(body).split(/\r?\n/)) {
      const [k, ...rest] = line.split("=");
      if (!k || rest.length === 0) continue;
      caps[k.trim()] = rest.join("=").trim();
    }
    // Capability URLs may be relative — resolve against login URL
    const base = new URL(this.cfg.loginUrl);
    for (const k of Object.keys(caps)) {
      const v = caps[k];
      if (typeof v === "string" && v.startsWith("/")) {
        caps[k] = `${base.protocol}//${base.host}${v}`;
      }
    }
    if (caps.MemberName) this.sessionId = caps.MemberName; // best-effort
    this.capabilities = caps;
    return caps as RetsCapabilities;
  }

  /** RETS Search returning COMPACT-DECODED rows, parsed into objects. */
  async search(opts: {
    resource: string;
    class: string;
    query: string;
    select?: string;
    limit?: number;
    offset?: number;
    standardNames?: boolean;
  }): Promise<{ columns: string[]; rows: Record<string, string>[]; total: number }> {
    if (!this.capabilities?.Search) throw new Error("Not logged in (no Search URL)");
    const params = new URLSearchParams({
      SearchType: opts.resource,
      Class: opts.class,
      QueryType: "DMQL2",
      Query: opts.query,
      Format: "COMPACT-DECODED",
      Count: "1",
      Limit: String(opts.limit ?? 100),
      Offset: String(opts.offset ?? 0),
      StandardNames: opts.standardNames === false ? "0" : "0",
    });
    if (opts.select) params.set("Select", opts.select);
    const url = `${this.capabilities.Search}?${params.toString()}`;
    const res = await this.request(url);
    const text = await res.text();
    if (!res.ok) throw new Error(`Search failed: ${res.status} ${text.slice(0, 300)}`);
    return this.parseCompactDecoded(text);
  }

  private parseCompactDecoded(xmlText: string): { columns: string[]; rows: Record<string, string>[]; total: number } {
    const xml = this.xmlParser.parse(xmlText);
    const replyCode = String(xml?.RETS?.["@_ReplyCode"] ?? "0");
    if (replyCode === "20201") return { columns: [], rows: [], total: 0 }; // No records found
    if (replyCode !== "0") {
      throw new Error(
        `RETS Search reply ${replyCode}: ${xml?.RETS?.["@_ReplyText"] ?? "(no message)"}`,
      );
    }
    const total = parseInt(String(xml?.RETS?.COUNT?.["@_Records"] ?? "0"), 10) || 0;
    const colsLine: string = String(xml?.RETS?.COLUMNS ?? "");
    if (!colsLine) return { columns: [], rows: [], total };
    // Tab-delimited; leading & trailing tabs produce empty entries we strip
    const columns = colsLine.split("\t").filter((s) => s.length > 0);
    const rawData = xml?.RETS?.DATA ?? [];
    const dataLines: string[] = Array.isArray(rawData) ? rawData : [rawData];
    const rows: Record<string, string>[] = [];
    for (const dl of dataLines) {
      if (dl === undefined || dl === null) continue;
      const fields = String(dl).split("\t");
      // Pillar 9 emits a leading tab on every DATA line. The first split entry
      // is therefore an empty string we must skip BEFORE column-index alignment.
      // Trailing tab produces an extra empty entry we ignore.
      const start = fields[0] === "" ? 1 : 0;
      const obj: Record<string, string> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = fields[start + i] ?? "";
      }
      rows.push(obj);
    }
    return { columns, rows, total };
  }

  /** Fetch GetMetadata for a class — useful for discovering field names. */
  async getMetadata(opts: { type: string; id: string; format?: string }) {
    if (!this.capabilities?.GetMetadata) throw new Error("Not logged in");
    const params = new URLSearchParams({
      Type: opts.type,
      ID: opts.id,
      Format: opts.format ?? "STANDARD-XML",
    });
    const url = `${this.capabilities.GetMetadata}?${params.toString()}`;
    const res = await this.request(url);
    const text = await res.text();
    return this.xmlParser.parse(text);
  }

  /**
   * RETS GetObject — fetch a binary photo for a listing.
   * Pillar 9 stores listing photos in resource=Property, type=LargePhoto (also
   * "Thumbnail" and "HiRes"). The ID format is "<MLSNumber>:<index>" where
   * index is 1-based or "*" to fetch all photos in a multipart response.
   *
   * Returns: { contentType, body } where body is a Uint8Array of JPEG bytes.
   */
  async getPhoto(opts: {
    resource: string;
    type: string; // "LargePhoto" | "Photo" | "Thumbnail"
    listingId: string;
    index: number; // 1-based
  }): Promise<{ contentType: string; body: Buffer } | null> {
    if (!this.capabilities?.GetObject) throw new Error("Not logged in (no GetObject URL)");
    const params = new URLSearchParams({
      Resource: opts.resource,
      Type: opts.type,
      ID: `${opts.listingId}:${opts.index}`,
      Location: "0",
    });
    const url = `${this.capabilities.GetObject}?${params.toString()}`;
    const res = await this.request(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GetObject failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const contentType = res.headers.get("content-type") || "image/jpeg";
    // Some RETS servers wrap an error in an XML body even with 200 — detect it
    if (contentType.includes("xml") || contentType.includes("text")) {
      const text = await res.text();
      // RETS error shape: <RETS ReplyCode="20403" ReplyText="No Object Found"/>
      // Only 20403 means the photo doesn't exist; any other code (session,
      // throttling, server busy) is a failure the caller should retry.
      if (/ReplyCode="20403"/.test(text)) return null;
      // Otherwise treat as opaque error
      throw new Error(`GetObject returned non-binary: ${text.slice(0, 200)}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return { contentType, body: Buffer.from(arrayBuffer) };
  }

  async logout() {
    if (this.capabilities?.Logout) {
      try { await this.request(this.capabilities.Logout); } catch {}
    }
  }
}
