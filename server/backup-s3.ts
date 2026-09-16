// S3-compatible client + AES-256-GCM file encryption for the offsite backup.
//
// Kept separate from backup.ts so script/restore-backup.ts can use the same
// signing and cipher code on a laptop without opening the app's database.
// See backup.ts for the env vars and the file layout.

import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { XMLParser } from "fast-xml-parser";

export const BACKUP_MAGIC = Buffer.from("RRBK");
export const BACKUP_VERSION = 1;

// ---- Config -------------------------------------------------------------------

export interface BackupConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  prefix: string;
  key: Buffer;
  keepDays: number;
}

export function backupConfig(): { config: BackupConfig | null; missing: string[] } {
  const need = [
    "BACKUP_S3_ENDPOINT",
    "BACKUP_S3_BUCKET",
    "BACKUP_S3_ACCESS_KEY",
    "BACKUP_S3_SECRET_KEY",
    "BACKUP_ENCRYPTION_KEY",
  ];
  const missing = need.filter((k) => !process.env[k]);
  const keyHex = process.env.BACKUP_ENCRYPTION_KEY ?? "";
  if (keyHex && !/^[0-9a-fA-F]{64}$/.test(keyHex)) missing.push("BACKUP_ENCRYPTION_KEY (must be 64 hex chars)");
  if (missing.length) return { config: null, missing };
  return {
    missing: [],
    config: {
      endpoint: process.env.BACKUP_S3_ENDPOINT!.replace(/\/+$/, ""),
      bucket: process.env.BACKUP_S3_BUCKET!,
      accessKey: process.env.BACKUP_S3_ACCESS_KEY!,
      secretKey: process.env.BACKUP_S3_SECRET_KEY!,
      region: process.env.BACKUP_S3_REGION || "auto",
      prefix: (process.env.BACKUP_S3_PREFIX || "rivers").replace(/^\/+|\/+$/g, ""),
      key: Buffer.from(keyHex, "hex"),
      keepDays: Math.max(1, parseInt(process.env.BACKUP_KEEP_DAYS || "90", 10) || 90),
    },
  };
}

// ---- SigV4 --------------------------------------------------------------------

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(p: string): string {
  return p.split("/").map(rfc3986).join("/");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDate(d = new Date()): { amz: string; date: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

export interface S3Request {
  method: "PUT" | "GET" | "DELETE";
  key: string; // object key, without bucket
  query?: Record<string, string>;
  payloadSha256: string;
  contentLength?: number;
  contentType?: string;
}

export function signedHeaders(cfg: BackupConfig, r: S3Request, now = new Date()): { url: URL; headers: Record<string, string> } {
  const url = new URL(`${cfg.endpoint}/${encodePath(cfg.bucket)}${r.key ? "/" + encodePath(r.key) : ""}`);
  const query = Object.entries(r.query ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");
  url.search = query;
  const { amz, date } = amzDate(now);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": r.payloadSha256,
    "x-amz-date": amz,
  };
  if (r.contentType) headers["content-type"] = r.contentType;
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const canonical = [
    r.method,
    url.pathname,
    query,
    canonicalHeaders,
    signedNames.join(";"),
    r.payloadSha256,
  ].join("\n");
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const kDate = hmac(`AWS4${cfg.secretKey}`, date);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
  if (r.contentLength !== undefined) headers["content-length"] = String(r.contentLength);
  return { url, headers };
}

function request(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: NodeJS.ReadableStream,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "http:" ? http : https;
    const req = lib.request(url, { method, headers, timeout: 10 * 60_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("S3 request timed out")));
    req.on("error", reject);
    if (body) body.pipe(req);
    else req.end();
  });
}

export async function s3PutFile(cfg: BackupConfig, key: string, filePath: string, sha256: string): Promise<void> {
  const size = fs.statSync(filePath).size;
  const { url, headers } = signedHeaders(cfg, {
    method: "PUT",
    key,
    payloadSha256: sha256,
    contentLength: size,
    contentType: "application/octet-stream",
  });
  const r = await request(url, "PUT", headers, fs.createReadStream(filePath));
  if (r.status < 200 || r.status >= 300) throw new Error(`S3 PUT failed (${r.status}): ${s3ErrorText(r.body)}`);
}

const EMPTY_SHA = createHash("sha256").update("").digest("hex");

/** "<Code>InvalidArgument</Code><Message>…</Message>" → "InvalidArgument: …". */
function s3ErrorText(body: string): string {
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
  const msg = /<Message>([^<]*)<\/Message>/.exec(body)?.[1];
  if (code || msg) return [code, msg].filter(Boolean).join(": ");
  return body.replace(/\s+/g, " ").slice(0, 200) || "no response body";
}

export async function s3List(cfg: BackupConfig, prefix: string): Promise<Array<{ key: string; lastModified: string; size: number }>> {
  const out: Array<{ key: string; lastModified: string; size: number }> = [];
  let token: string | undefined;
  const parser = new XMLParser();
  do {
    const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
    if (token) query["continuation-token"] = token;
    const { url, headers } = signedHeaders(cfg, { method: "GET", key: "", query, payloadSha256: EMPTY_SHA });
    const r = await request(url, "GET", headers);
    if (r.status !== 200) throw new Error(`S3 LIST failed (${r.status}): ${s3ErrorText(r.body)}`);
    const xml = parser.parse(r.body);
    const result = xml?.ListBucketResult ?? {};
    const contents = result.Contents ? (Array.isArray(result.Contents) ? result.Contents : [result.Contents]) : [];
    for (const c of contents) out.push({ key: String(c.Key), lastModified: String(c.LastModified), size: Number(c.Size) || 0 });
    token = result.IsTruncated === true || result.IsTruncated === "true" ? String(result.NextContinuationToken) : undefined;
  } while (token);
  return out;
}

export async function s3Delete(cfg: BackupConfig, key: string): Promise<void> {
  const { url, headers } = signedHeaders(cfg, { method: "DELETE", key, payloadSha256: EMPTY_SHA });
  const r = await request(url, "DELETE", headers);
  if (r.status !== 204 && r.status !== 200) throw new Error(`S3 DELETE ${key} failed: ${r.status}`);
}

export async function s3GetToFile(cfg: BackupConfig, key: string, dest: string): Promise<void> {
  const { url, headers } = signedHeaders(cfg, { method: "GET", key, payloadSha256: EMPTY_SHA });
  await new Promise<void>((resolve, reject) => {
    const lib = url.protocol === "http:" ? http : https;
    const req = lib.request(url, { method: "GET", headers }, (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        reject(new Error(`S3 GET ${key} failed: ${res.statusCode}`));
        res.resume();
        return;
      }
      const w = fs.createWriteStream(dest);
      res.pipe(w);
      w.on("finish", () => resolve());
      w.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// ---- Encryption -----------------------------------------------------------------

/**
 * Encrypt `source` (optionally gzipped first) into `dest`. File layout:
 *   "RRBK" | version (1 byte) | IV (12 bytes) | ciphertext | GCM tag (16 bytes)
 * Returns the SHA-256 of the written file, which the upload is signed with.
 */
export async function encryptToFile(
  source: NodeJS.ReadableStream,
  dest: string,
  key: Buffer,
  opts: { gzip?: boolean } = {},
): Promise<{ sha256: string; bytes: number }> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const hash = createHash("sha256");
  let bytes = 0;
  const header = Buffer.concat([BACKUP_MAGIC, Buffer.from([BACKUP_VERSION]), iv]);
  const out = fs.createWriteStream(dest);
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  hash.update(header);
  bytes += header.length;
  out.write(header);
  const stages: any[] = [source];
  if (opts.gzip) stages.push(zlib.createGzip({ level: 6 }));
  stages.push(cipher, tap, out);
  await pipeline(stages as any);
  const tag = cipher.getAuthTag();
  hash.update(tag);
  bytes += tag.length;
  await fs.promises.appendFile(dest, tag);
  return { sha256: hash.digest("hex"), bytes };
}


/** Inverse of encryptToFile, in memory (restore runs on a laptop, not the server). */
export function decryptBuffer(enc: Buffer, key: Buffer, opts: { gunzip?: boolean } = {}): Buffer {
  if (enc.length < 4 + 1 + 12 + 16 || !enc.subarray(0, 4).equals(BACKUP_MAGIC)) {
    throw new Error("Not a Rivers backup file (bad header)");
  }
  const version = enc[4];
  if (version !== BACKUP_VERSION) throw new Error(`Unsupported backup version ${version}`);
  const iv = enc.subarray(5, 17);
  const tag = enc.subarray(enc.length - 16);
  const body = enc.subarray(17, enc.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return opts.gunzip ? zlib.gunzipSync(plain) : plain;
}
