#!/usr/bin/env node
// Dependency-free S3 client for storing files a Claude Code session downloads
// or produces. Works with any S3-compatible provider — Backblaze B2, Cloudflare
// R2, MinIO, AWS — over plain `node` (SigV4 on top of fetch, no npm install).
//
// Env (set in the claude.ai environment settings, never committed):
//   S3_ACCESS_KEY_ID      key id / application key id
//   S3_SECRET_ACCESS_KEY  secret
//   S3_ENDPOINT           provider endpoint, e.g.
//                           https://s3.us-west-004.backblazeb2.com   (Backblaze B2)
//                           https://<account-id>.r2.cloudflarestorage.com  (Cloudflare R2)
//                           http://127.0.0.1:9000                    (MinIO, local tests)
//   S3_BUCKET             bucket name (default: claude-downloads)
//   S3_REGION             optional; inferred from the endpoint, else "auto"
//   S3_PUBLIC_URL         optional public base URL of the bucket, used by `url --public`
// The R2_* names are accepted as aliases; with R2_ACCOUNT_ID set the R2
// endpoint is built automatically.
//
// Usage:
//   node store.mjs ls [prefix]                # list objects (recursive)
//   node store.mjs put <file> [key]           # upload; key ending in "/" keeps the file name
//   node store.mjs get <key> [file]           # download (default: basename of key in cwd)
//   node store.mjs cat <key>                  # print object to stdout
//   node store.mjs head <key>                 # size, type, last-modified
//   node store.mjs rm <key> [key...]          # delete
//   node store.mjs url <key> [seconds]        # presigned download link (default 1h, max 7d)
//   node store.mjs url --public <key>         # plain link on S3_PUBLIC_URL
//   node store.mjs mb                         # create the bucket if it does not exist
//   node store.mjs buckets                    # list buckets visible to the key

import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const env = process.env;
const pick = (...names) => names.map((n) => process.env[n]).find((v) => v);

const ACCESS_KEY = pick("S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID", "B2_ACCESS_KEY_ID");
const SECRET_KEY = pick("S3_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY", "B2_SECRET_ACCESS_KEY");
const BUCKET = pick("S3_BUCKET", "R2_BUCKET", "B2_BUCKET") || "claude-downloads";
const PUBLIC_URL = pick("S3_PUBLIC_URL", "R2_PUBLIC_URL", "B2_PUBLIC_URL");
const RAW_ENDPOINT =
  pick("S3_ENDPOINT", "R2_ENDPOINT", "B2_ENDPOINT") ||
  (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
const SERVICE = "s3";

// B2 and AWS sign with the region embedded in their endpoint; R2 uses "auto".
function inferRegion(raw) {
  const explicit = pick("S3_REGION", "R2_REGION", "B2_REGION", "AWS_REGION");
  if (explicit) return explicit;
  if (!raw) return "auto";
  const host = raw.replace(/^\w+:\/\//, "").split("/")[0];
  if (host.endsWith(".backblazeb2.com")) return host.match(/^s3\.([^.]+)\./)?.[1] ?? "auto";
  if (host.endsWith(".amazonaws.com")) return host.match(/^s3[.-]([^.]+)\.amazonaws/)?.[1] ?? "us-east-1";
  return "auto";
}
const REGION = inferRegion(RAW_ENDPOINT);

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const args = argv.filter((a) => !a.startsWith("--"));
const [cmd, ...rest] = args;

function usage(code = 2) {
  console.error(
    [
      "Usage: node store.mjs <command> [...]",
      "  ls [prefix] | put <file> [key] | get <key> [file] | cat <key> | head <key>",
      "  rm <key>... | url <key> [seconds] | url --public <key> | mb | buckets",
      "Env: S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY [, S3_BUCKET, S3_REGION, S3_PUBLIC_URL]",
    ].join("\n"),
  );
  process.exit(code);
}

if (!cmd || flags.has("--help")) usage(cmd ? 0 : 2);

function requireEnv() {
  const missing = [];
  if (!ACCESS_KEY) missing.push("S3_ACCESS_KEY_ID");
  if (!SECRET_KEY) missing.push("S3_SECRET_ACCESS_KEY");
  if (!RAW_ENDPOINT) missing.push("S3_ENDPOINT");
  if (missing.length) {
    console.error(
      `Missing ${missing.join(", ")}. Set them in the claude.ai environment settings ` +
        "(Backblaze: Account -> Application Keys; Cloudflare: R2 -> Manage API Tokens). " +
        "They are secrets: never commit them.",
    );
    process.exit(2);
  }
}

function endpoint() {
  return new URL(RAW_ENDPOINT.replace(/\/+$/, ""));
}

// ---------- SigV4 ----------

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// RFC 3986 encoding as S3 expects it ("/" is kept only when asked).
function awsEncode(str, keepSlash = false) {
  const enc = encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? enc.replace(/%2F/g, "/") : enc;
}

function amzDate(d = new Date()) {
  const iso = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

function signingKey(secret, date) {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${awsEncode(k)}=${awsEncode(String(params[k]))}`)
    .join("&");
}

/**
 * Build a signed request. `key` is the object key (already decoded); `params` are
 * query params; `headers` extra headers. Returns { url, headers } for fetch.
 */
function sign({ method, bucket = BUCKET, key = "", params = {}, headers = {}, payloadHash = "UNSIGNED-PAYLOAD" }) {
  const base = endpoint();
  const pathParts = [bucket, ...key.split("/").filter((p) => p !== "")].map((p) => awsEncode(p));
  const canonicalUri = "/" + (bucket ? pathParts.join("/") : "") + (key.endsWith("/") ? "/" : "");
  const { amz, date } = amzDate();

  const hdrs = {
    host: base.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
  };
  const signedHeaders = Object.keys(hdrs).sort();
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${hdrs[k]}\n`).join("");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(params),
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(SECRET_KEY, date)).update(stringToSign).digest("hex");

  const { host, ...sendHeaders } = hdrs;
  sendHeaders.authorization =
    `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, ` +
    `SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;
  const qs = canonicalQuery(params);
  return { url: `${base.origin}${canonicalUri}${qs ? `?${qs}` : ""}`, headers: sendHeaders };
}

function presign({ key, expires }) {
  const base = endpoint();
  const canonicalUri = "/" + [BUCKET, ...key.split("/").filter(Boolean)].map((p) => awsEncode(p)).join("/");
  const { amz, date } = amzDate();
  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${ACCESS_KEY}/${scope}`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalRequest = ["GET", canonicalUri, canonicalQuery(params), `host:${base.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(SECRET_KEY, date)).update(stringToSign).digest("hex");
  return `${base.origin}${canonicalUri}?${canonicalQuery(params)}&X-Amz-Signature=${signature}`;
}

// ---------- HTTP helpers ----------

async function request(opts, fetchInit = {}) {
  const { url, headers } = sign(opts);
  const res = await fetch(url, { method: opts.method, headers, ...fetchInit });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const code = body.match(/<Code>([^<]*)<\/Code>/)?.[1];
    const msg = body.match(/<Message>([^<]*)<\/Message>/)?.[1];
    const err = new Error(`HTTP ${res.status}${code ? ` ${code}` : ""}${msg ? `: ${msg}` : ""}`);
    err.status = res.status;
    err.code = code;
    throw err;
  }
  return res;
}

const xmlUnescape = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, "&");
const xmlTag = (xml, tag) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? "";

const MIME = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".xml": "application/xml",
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed", ".rar": "application/vnd.rar",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const mimeOf = (file) => MIME[extname(file).toLowerCase()] ?? "application/octet-stream";

function fmtSize(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

// ---------- commands ----------

async function cmdLs(prefix = "") {
  let token;
  let count = 0;
  let total = 0;
  do {
    const params = { "list-type": "2", "max-keys": "1000" };
    if (prefix) params.prefix = prefix;
    if (token) params["continuation-token"] = token;
    const xml = await (await request({ method: "GET", params })).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlUnescape(xmlTag(m[1], "Key"));
      const size = xmlTag(m[1], "Size");
      const mod = xmlTag(m[1], "LastModified").replace(/\.\d+Z$/, "Z");
      console.log(`${fmtSize(size).padStart(10)}  ${mod}  ${key}`);
      count += 1;
      total += Number(size);
    }
    token = xmlTag(xml, "IsTruncated") === "true" ? xmlUnescape(xmlTag(xml, "NextContinuationToken")) : undefined;
  } while (token);
  console.log(`${count} object${count === 1 ? "" : "s"}, ${fmtSize(total)}${prefix ? ` under "${prefix}"` : ""} in ${BUCKET}`);
}

async function cmdPut(file, key) {
  if (!file) usage();
  const size = statSync(file).size;
  if (!key || key.endsWith("/")) key = `${key ?? ""}${basename(file)}`;
  await request(
    { method: "PUT", key, headers: { "content-type": mimeOf(file), "content-length": size } },
    { body: Readable.toWeb(createReadStream(file)), duplex: "half" },
  );
  console.log(`uploaded ${file} -> s3://${BUCKET}/${key} (${fmtSize(size)})`);
}

async function cmdGet(key, file) {
  if (!key) usage();
  file ||= basename(key);
  const res = await request({ method: "GET", key });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  console.log(`downloaded s3://${BUCKET}/${key} -> ${file} (${fmtSize(statSync(file).size)})`);
}

async function cmdCat(key) {
  if (!key) usage();
  const res = await request({ method: "GET", key });
  await pipeline(Readable.fromWeb(res.body), process.stdout, { end: false });
}

async function cmdHead(key) {
  if (!key) usage();
  const res = await request({ method: "HEAD", key });
  console.log(`key:           ${key}`);
  console.log(`size:          ${fmtSize(res.headers.get("content-length") ?? 0)} (${res.headers.get("content-length")} bytes)`);
  console.log(`content-type:  ${res.headers.get("content-type")}`);
  console.log(`last-modified: ${res.headers.get("last-modified")}`);
  console.log(`etag:          ${res.headers.get("etag")}`);
}

async function cmdRm(...keys) {
  if (!keys.length) usage();
  for (const key of keys) {
    await request({ method: "DELETE", key });
    console.log(`deleted s3://${BUCKET}/${key}`);
  }
}

function cmdUrl(key, seconds) {
  if (!key) usage();
  if (flags.has("--public")) {
    if (!PUBLIC_URL) {
      console.error("S3_PUBLIC_URL is not set (make the bucket public and set its base URL).");
      process.exit(2);
    }
    console.log(`${PUBLIC_URL.replace(/\/+$/, "")}/${key.split("/").map((p) => awsEncode(p)).join("/")}`);
    return;
  }
  const expires = Math.min(Math.max(Number(seconds) || 3600, 1), 7 * 24 * 3600);
  console.log(presign({ key, expires }));
}

async function cmdMb() {
  try {
    await request({ method: "PUT" });
    console.log(`created bucket ${BUCKET}`);
  } catch (err) {
    if (err.code === "BucketAlreadyOwnedByYou" || err.code === "BucketAlreadyExists") {
      console.log(`bucket ${BUCKET} already exists`);
      return;
    }
    throw err;
  }
}

async function cmdBuckets() {
  let xml;
  try {
    xml = await (await request({ method: "GET", bucket: "" })).text();
  } catch (err) {
    // A key scoped to one bucket cannot list the account's buckets. That is the
    // recommended setup, so report it as configuration, not as a failure.
    if (err.status === 403) {
      console.log(`(this key is restricted to a single bucket: ${BUCKET})`);
      return;
    }
    throw err;
  }
  const names = [...xml.matchAll(/<Bucket>[\s\S]*?<Name>([^<]*)<\/Name>/g)].map((m) => xmlUnescape(m[1]));
  if (!names.length) console.log("(no buckets visible to this key)");
  for (const n of names) console.log(n);
}

const commands = { ls: cmdLs, put: cmdPut, get: cmdGet, cat: cmdCat, head: cmdHead, rm: cmdRm, url: cmdUrl, mb: cmdMb, buckets: cmdBuckets };
if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  usage();
}
requireEnv();
try {
  await commands[cmd](...rest);
} catch (err) {
  const hint =
    err.cause?.code === "ENOTFOUND" || err.cause?.code === "ECONNREFUSED"
      ? " (check S3_ENDPOINT)"
      : err.status === 403
        ? " (check the key id/secret and that the key has access to this bucket)"
        : err.status === 404 && err.code === "NoSuchBucket"
          ? ` (bucket "${BUCKET}" does not exist; run: node store.mjs mb)`
          : "";
  console.error(`${err.message ?? err}${hint}`);
  process.exit(1);
}
