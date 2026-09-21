#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const baseUrl = process.argv[2] || process.env.FEMOS_EXECUTION_SERVER_URL;
if (!baseUrl) throw new Error("Provide the FEMOS HTTPS URL as the first argument.");
const endpoint = new URL(baseUrl);
const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
if (endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:")) throw new Error("Enrollment requires HTTPS or loopback HTTP.");

const defaultDataDir = platform() === "win32"
  ? join(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), "FEMOS Worker")
  : platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "FEMOS Worker")
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "femos-worker");
const identityPath = process.env.FEMOS_WORKER_IDENTITY_PATH || join(process.env.FEMOS_WORKER_DATA_DIR || defaultDataDir, "worker-identity.json");
try {
  await access(identityPath);
  throw new Error("This computer already has a Worker identity. Revoke it before enrolling a replacement.");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

let input = "";
for await (const chunk of process.stdin) {
  input += chunk.toString();
  if (input.length > 1_000) throw new Error("Enrollment token input is too long.");
}
const token = input.trim();
if (!/^femos_enroll_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Enter a valid one-time enrollment token on stdin.");
const response = await fetch(new URL("/api/v1/worker/enroll", endpoint), { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token, version: "2.3.0" }), signal: AbortSignal.timeout(15_000) });
const result = await response.json().catch(() => ({}));
if (!response.ok || !result.workerId || !result.credential) throw new Error(result.error ?? "Enrollment failed.");
await mkdir(dirname(identityPath), { recursive: true, mode: 0o700 });
const temporary = `${identityPath}.${randomUUID()}.tmp`;
await writeFile(temporary, JSON.stringify({ workerId: result.workerId, credential: result.credential,
  serverUrl: endpoint.toString().replace(/\/$/, "") }), { mode: 0o600, flag: "wx" });
await rename(temporary, identityPath);
console.log(`Enrolled Worker ${result.workerId}. Credential saved to a protected local identity file.`);
