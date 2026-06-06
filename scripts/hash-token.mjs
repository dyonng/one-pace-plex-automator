// Generates a DASHBOARD_TOKEN_HASH for the dashboard (scrypt, salted).
// Usage:  npm run hash-token -- <password>
// Then put the printed line in your .env. The plaintext is never stored.
//
// Note: passing the password as an argument leaves it in shell history /
// process list. For a one-time setup that's usually fine; clear history if it
// matters. Format must match src/web/auth.ts (scrypt$<saltHex>$<hashHex>).

import { scryptSync, randomBytes } from "crypto";

const password = process.argv[2];
if (!password) {
  console.error("usage: npm run hash-token -- <password>");
  process.exit(1);
}

const salt = randomBytes(16);
const key = scryptSync(password, salt, 32);
console.log(`DASHBOARD_TOKEN_HASH=scrypt$${salt.toString("hex")}$${key.toString("hex")}`);
