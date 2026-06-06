import { scryptSync, randomBytes, timingSafeEqual, createHash } from "crypto";
import { getConfig } from "../config";
import { logger } from "../logger";

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

export type Verifier = (password: string) => boolean;

/**
 * Builds the password verifier from config. Prefers DASHBOARD_TOKEN_HASH (stored
 * hash, no plaintext at rest); falls back to plaintext DASHBOARD_TOKEN with a
 * warning. Returns null when neither is set (dashboard disabled).
 */
export function buildAuth(): Verifier | null {
  const { DASHBOARD_TOKEN_HASH, DASHBOARD_TOKEN } = getConfig();

  if (DASHBOARD_TOKEN_HASH) {
    return (password: string) => {
      const fp = sha256(password);
      if (_verifiedFingerprint && safeEq(fp, _verifiedFingerprint)) return true; // fast path
      if (verifyAgainstHash(password, DASHBOARD_TOKEN_HASH)) {
        _verifiedFingerprint = fp;
        return true;
      }
      return false;
    };
  }

  if (DASHBOARD_TOKEN) {
    logger.warn(
      "Dashboard using plaintext DASHBOARD_TOKEN — generate DASHBOARD_TOKEN_HASH instead (npm run hash-token)"
    );
    const expected = sha256(DASHBOARD_TOKEN);
    return (password: string) => safeEq(sha256(password), expected);
  }

  return null;
}
