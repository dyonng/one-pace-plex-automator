import http from "http";
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "crypto";
import { getConfig } from "../config";
import { getKv, setKv } from "../db";

const KV_AUTH_ENABLED = "auth_enabled";
const KV_AUTH_HASH = "auth_hash";

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function safeEq(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Produce a `scrypt$<saltHex>$<hashHex>` string for storage. */
export function hashToken(plain: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, 32);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

function verifyAgainstHash(plain: string, spec: string): boolean {
  const parts = spec.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const key = scryptSync(plain, salt, expected.length);
  return safeEq(key, expected);
}

// scrypt is deliberately slow; cache the fingerprint of the last verified password
// so the expensive hash runs once, not on every dashboard poll / SSE request.
let _verifiedFingerprint: Buffer | null = null;

// Effective hash: UI-set (DB) wins over env DASHBOARD_TOKEN_HASH.
function effectiveHash(): string | null {
  return getKv(KV_AUTH_HASH) ?? getConfig().DASHBOARD_TOKEN_HASH ?? null;
}

/** A password/secret exists somewhere (DB hash, env hash, or env plaintext). */
export function hasSecret(): boolean {
  return Boolean(effectiveHash() || getConfig().DASHBOARD_TOKEN);
}

/** Whether auth is enforced. Default: enabled iff a secret exists. */
export function isAuthEnabled(): boolean {
  const raw = getKv(KV_AUTH_ENABLED);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return hasSecret();
}

export function getAuthState(): { enabled: boolean; hasPassword: boolean } {
  return { enabled: isAuthEnabled(), hasPassword: hasSecret() };
}

export function setPassword(plain: string): void {
  setKv(KV_AUTH_HASH, hashToken(plain));
  _verifiedFingerprint = null; // invalidate cache so the old password stops working
}

export function setAuthEnabled(enabled: boolean): { ok: boolean; message: string } {
  if (enabled && !hasSecret()) {
    return { ok: false, message: "Set a password before enabling authentication" };
  }
  setKv(KV_AUTH_ENABLED, enabled ? "true" : "false");
  return { ok: true, message: enabled ? "Authentication enabled" : "Authentication disabled" };
}

function verifyPassword(password: string): boolean {
  const spec = effectiveHash();
  if (spec) {
    const fp = sha256(password);
    if (_verifiedFingerprint && safeEq(fp, _verifiedFingerprint)) return true; // fast path
    if (verifyAgainstHash(password, spec)) {
      _verifiedFingerprint = fp;
      return true;
    }
    return false;
  }
  const plain = getConfig().DASHBOARD_TOKEN;
  if (plain) return safeEq(sha256(password), sha256(plain));
  return false;
}

/** Per-request gate. Open (true) when auth is disabled; otherwise checks Basic auth. */
export function checkRequestAuth(req: http.IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const pass = decoded.slice(decoded.indexOf(":") + 1);
  return verifyPassword(pass);
}
