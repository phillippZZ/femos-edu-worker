#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const defaultDataDir = platform() === "win32"
  ? join(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), "FEMOS Worker")
  : platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "FEMOS Worker")
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "femos-worker");
const identityPath = process.env.FEMOS_WORKER_IDENTITY_PATH || join(process.env.FEMOS_WORKER_DATA_DIR || defaultDataDir, "worker-identity.json");
const metadata = await stat(identityPath);
if (platform() !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Worker identity file permissions are too broad.");
const identity = JSON.parse(await readFile(identityPath, "utf8"));
if (!/^femos_worker_[A-Za-z0-9_-]{43}$/.test(identity.credential)) throw new Error("Invalid Worker identity.");
const url = new URL(identity.serverUrl);
if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
  throw new Error("Worker server URL must use HTTPS or loopback HTTP.");
}
const response = await fetch(new URL("/api/v1/worker/rotate", url), { method: "POST",
  headers: { Authorization: `Bearer ${identity.credential}` }, signal: AbortSignal.timeout(15_000) });
const body = await response.json().catch(() => ({}));
if (!response.ok || body.workerId !== identity.workerId || !/^femos_worker_[A-Za-z0-9_-]{43}$/.test(body.credential)) {
  throw new Error(body.error ?? "Worker credential rotation failed.");
}
const temporary = `${identityPath}.${randomUUID()}.tmp`;
await writeFile(temporary, JSON.stringify({ ...identity, credential: body.credential }), { mode: 0o600, flag: "wx" });
await rename(temporary, identityPath);
console.log("Worker credential rotated. Restart the Worker within 10 minutes to use it.");
