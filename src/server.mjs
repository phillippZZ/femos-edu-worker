#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildEspOtaUploadArgs, buildUsbUploadArgs } from "./upload-command.mjs";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.FEMOS_UPLOADER_PORT ?? "32145", 10);
const VERSION = "2.1.0";
const BUNDLED_ARDUINO_CLI = join(dirname(process.execPath), platform() === "win32" ? "arduino-cli.exe" : "arduino-cli");
const ARDUINO_CLI = process.env.ARDUINO_CLI_PATH || (existsSync(BUNDLED_ARDUINO_CLI) ? BUNDLED_ARDUINO_CLI : "arduino-cli");
const SERVICE_COMPILER = process.env.FEMOS_SERVICE_COMPILER === "true";
const MAX_BODY_BYTES = 17_000_000;
const TARGETS = new Map([
  ["arduino-uno-r3", { fqbn: "arduino:avr:uno", core: "arduino:avr", label: "Arduino Uno R3", uploadSupported: "web-serial" }],
  ["arduino-uno-q", { fqbn: "arduino:zephyr:unoq", core: "arduino:zephyr", label: "Arduino UNO Q", uploadSupported: "local-helper" }],
  ["esp32-arduino", { fqbn: "esp32:esp32:esp32", core: "esp32:esp32", indexUrl: "https://espressif.github.io/arduino-esp32/package_esp32_index.json", label: "ESP32", uploadSupported: "local-helper" }],
]);
const ALLOWED_ORIGINS = new Set(
  (process.env.FEMOS_UPLOADER_ORIGINS ??
    "https://femos.ai,https://www.femos.ai,http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
let activeUpload = false;
let activeMonitor = null;
let activeCompiles = 0;
const compileWaiters = [];
const compileCache = new Map();
const compileInflight = new Map();
const coreInstalls = new Map();
let COMPILE_CONCURRENCY = Math.max(1, Math.min(4, Number.parseInt(process.env.FEMOS_WORKER_COMPILE_CONCURRENCY ?? "2", 10) || 2));
let COMPILE_JOBS = Math.max(1, Math.min(4, Number.parseInt(process.env.FEMOS_WORKER_COMPILE_JOBS ?? "2", 10) || 2));
const DEFAULT_DATA_DIR = platform() === "win32"
  ? join(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), "FEMOS Worker")
  : platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "FEMOS Worker")
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "femos-worker");
const WORKER_DATA_DIR = (process.env.FEMOS_WORKER_DATA_DIR || DEFAULT_DATA_DIR).replace(/[\\/]+$/, "");
const FIRMWARE_CACHE_DIR = (process.env.FEMOS_FIRMWARE_CACHE_DIR || join(WORKER_DATA_DIR, "firmware-cache")).replace(/[\\/]+$/, "");
const WORKER_SETTINGS_PATH = process.env.FEMOS_WORKER_SETTINGS_PATH || join(WORKER_DATA_DIR, "worker-settings.json");
const FIRMWARE_CACHE_TTL = 7 * 24 * 60 * 60 * 1_000;
const FIRMWARE_CACHE_LIMIT = 64;
let workerSettings = {
  profile: "balanced",
  compileConcurrency: COMPILE_CONCURRENCY,
  jobsPerCompile: COMPILE_JOBS,
  useForMyBuilds: true,
  useForLan: true,
  contributePublic: SERVICE_COMPILER,
};

function safeWorkerSettings(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const profile = ["low-power", "balanced", "performance", "custom"].includes(candidate.profile)
    ? candidate.profile
    : "custom";
  const compileConcurrency = Number(candidate.compileConcurrency);
  const jobsPerCompile = Number(candidate.jobsPerCompile);
  if (!Number.isInteger(compileConcurrency) || compileConcurrency < 1 || compileConcurrency > 4) return null;
  if (!Number.isInteger(jobsPerCompile) || jobsPerCompile < 1 || jobsPerCompile > 4) return null;
  return {
    profile,
    compileConcurrency,
    jobsPerCompile,
    useForMyBuilds: candidate.useForMyBuilds !== false,
    useForLan: candidate.useForLan !== false,
    // Only a FEMOS-managed process may advertise global compilation.
    contributePublic: SERVICE_COMPILER,
  };
}

async function loadWorkerSettings() {
  try {
    const saved = safeWorkerSettings(JSON.parse(await readFile(WORKER_SETTINGS_PATH, "utf8")));
    if (saved) workerSettings = saved;
  } catch {
    // First run or unavailable external disk: keep safe defaults.
  }
  COMPILE_CONCURRENCY = workerSettings.compileConcurrency;
  COMPILE_JOBS = workerSettings.jobsPerCompile;
}

async function saveWorkerSettings(settings) {
  const directory = dirname(WORKER_SETTINGS_PATH);
  const temporary = `${WORKER_SETTINGS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, WORKER_SETTINGS_PATH);
}

await loadWorkerSettings();

function isAllowedHost(request) {
  const host = request.headers.host?.split(":")[0];
  return host === HOST || host === "localhost";
}

function applyCors(request, response) {
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Cache-Control", "no-store");
}

function rejectForbiddenRequest(request, response) {
  if (!isAllowedHost(request)) {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Invalid local uploader host." }));
    return true;
  }
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "This website cannot use the FEMOS uploader." }));
    return true;
  }
  return false;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("The firmware bundle is too large for the local uploader.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("The local uploader received invalid JSON.");
  }
}

function runExecutable(executable, args, { signal, timeout, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = "";
    let stdout = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      callback();
    };
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("Upload stopped.")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish(() => reject(new Error(`Arduino CLI timed out while running ${args[0]}.`)));
    }, timeout ?? 120_000);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout = `${stdout}${text}`;
      diagnostics = `${diagnostics}${text}`.slice(-12_000);
      onOutput?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      diagnostics = `${diagnostics}${text}`.slice(-12_000);
      onOutput?.(text);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) =>
      finish(() =>
        code === 0
          ? resolve(args.includes("--format") && args.includes("json") ? stdout : diagnostics)
          : reject(new Error(diagnostics.trim() || `Arduino CLI exited with code ${code}.`)),
      ),
    );
    if (signal?.aborted) stop();
  });
}

function runCommand(args, options) {
  return runExecutable(ARDUINO_CLI, args, options);
}

function coreInstalled(coreList, coreId) {
  return Array.isArray(coreList?.platforms) && coreList.platforms.some((item) =>
    item?.id === coreId &&
    item.releases &&
    Object.values(item.releases).some((release) => release?.installed === true));
}

async function ensureCore(target, signal) {
  const existing = coreInstalls.get(target.core);
  if (existing) return existing;
  const install = (async () => {
    const current = JSON.parse(await runCommand(
      ["core", "list", "--format", "json"],
      { signal, timeout: 20_000 },
    ));
    if (coreInstalled(current, target.core)) return;
    if (target.indexUrl) {
      await runCommand(
        ["config", "add", "board_manager.additional_urls", target.indexUrl],
        { signal, timeout: 20_000 },
      );
    }
    await runCommand(["core", "update-index"], { signal, timeout: 120_000 });
    await runCommand(
      ["core", "install", target.core],
      { signal, timeout: 20 * 60_000 },
    );
  })();
  coreInstalls.set(target.core, install);
  try {
    await install;
  } catch (error) {
    coreInstalls.delete(target.core);
    throw error;
  }
}

function safeProvisioningSettings(body) {
  const wifiSsid = typeof body.wifiSsid === "string" ? body.wifiSsid : "";
  const wifiPassword = typeof body.wifiPassword === "string" ? body.wifiPassword : "";
  const hostname = typeof body.hostname === "string" ? body.hostname.trim() : "";
  const otaPassword = typeof body.otaPassword === "string" ? body.otaPassword : "";
  if (
    !wifiSsid || wifiSsid.length > 32 || /[\r\n]/.test(wifiSsid) ||
    !wifiPassword || wifiPassword.length > 63 || /[\r\n]/.test(wifiPassword) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/i.test(hostname) ||
    otaPassword.length < 8 || otaPassword.length > 64 || /[\r\n]/.test(otaPassword)
  ) return null;
  return { wifiSsid, wifiPassword, hostname, otaPassword };
}

function serialProvisioningPayload(settings) {
  const hex = (value) => Buffer.from(value, "utf8").toString("hex").toUpperCase();
  return `FEMOS_CONFIG_V1\n${hex(settings.wifiSsid)}\n${hex(settings.wifiPassword)}\n${hex(settings.hostname)}\n${hex(settings.otaPassword)}\n`;
}

function configureEsp32OverSerial({ port, fqbn, settings, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ARDUINO_CLI,
      ["monitor", "--quiet", "--raw", "--port", port, "--fqbn", fqbn, "--config", "baudrate=115200"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const payload = serialProvisioningPayload(settings);
    let output = "";
    let settled = false;
    let sender;
    let timeout;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(sender);
      signal?.removeEventListener("abort", stop);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      if (error) reject(error);
      else resolve();
    };
    const stop = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("ESP32 setup stopped."));
    const inspect = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8_000);
      if (output.includes("FEMOS_CONFIG_OK")) finish();
      else if (output.includes("FEMOS_CONFIG_ERROR")) finish(new Error("The ESP32 rejected the wireless settings."));
    };
    const send = () => {
      if (!settled && child.stdin.writable) child.stdin.write(payload);
    };
    sender = setInterval(send, 1_000);
    timeout = setTimeout(
      () => finish(new Error("The ESP32 was flashed but did not confirm its wireless settings over USB. Keep it connected and try setup again.")),
      25_000,
    );
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(output.trim() || `Serial configuration stopped with code ${code}.`));
    });
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    setTimeout(send, 1_200).unref();
  });
}

async function listBoards(signal) {
  const output = await runCommand(["board", "list", "--format", "json"], {
    signal,
    timeout: 15_000,
  });
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed.detected_ports) ? parsed.detected_ports : []).flatMap(
    (entry) => {
      const port = entry?.port;
      if (!port || typeof port.address !== "string") return [];
      const boards = Array.isArray(entry.matching_boards) ? entry.matching_boards : [];
      const properties = port.properties && typeof port.properties === "object"
        ? port.properties
        : {};
      const looksLikeUsbSerial =
        /usb/i.test(String(port.protocol_label ?? "")) ||
        typeof properties.vid === "string" ||
        /(?:usbmodem|usbserial|ttyUSB|ttyACM)/i.test(port.address);
      const recognized = boards.flatMap((board) =>
        typeof board?.fqbn === "string"
          ? [{
              address: port.address,
              label: typeof port.label === "string" ? port.label : port.address,
              boardName: typeof board.name === "string" ? board.name : board.fqbn,
              fqbn: board.fqbn,
            }]
          : [],
      );
      if (
        port.protocol === "serial" &&
        looksLikeUsbSerial &&
        (boards.length === 0 || boards.some((board) => board?.fqbn?.startsWith("esp32:"))) &&
        !recognized.some((board) => board.fqbn === "esp32:esp32:esp32")
      ) {
        recognized.push({
          address: port.address,
          label: typeof port.label === "string" ? port.label : port.address,
          boardName: "ESP32-compatible serial port",
          fqbn: "esp32:esp32:esp32",
        });
      }
      return recognized;
    },
  );
}

function safeOtaPort(value) {
  const port = typeof value === "string" ? value.trim() : "";
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(port)) {
    const octets = port.split(".").map(Number);
    return octets.every((octet) => octet >= 0 && octet <= 255) ? port : null;
  }
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/i.test(port)
    ? port
    : null;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendEvent(response, event) {
  response.write(`${JSON.stringify(event)}\n`);
}

function publicUploadError(error, targetLabel) {
  const message = error instanceof Error ? error.message : `${targetLabel} upload failed.`;
  if (/authentication failed|check your password/i.test(message))
    return "The OTA password does not match this ESP32. Use the OTA password created during Wi-Fi setup—not the Wi-Fi password. If it was forgotten, reconnect USB and run Wi-Fi setup again.";
  return message.slice(-8_000);
}

function stopActiveMonitor(message = "Serial Monitor disconnected.") {
  const monitor = activeMonitor;
  if (!monitor) return;
  activeMonitor = null;
  monitor.child.kill("SIGTERM");
  setTimeout(() => monitor.child.kill("SIGKILL"), 2_000).unref();
  if (!monitor.response.writableEnded) {
    sendEvent(monitor.response, { type: "disconnected", message });
    monitor.response.end();
  }
}

function safeFirmwareArtifact(candidate, targetId, fqbn) {
  if (!candidate || typeof candidate !== "object" || candidate.targetId !== targetId || candidate.boardFqbn !== fqbn || !Array.isArray(candidate.files) || candidate.files.length < 1 || candidate.files.length > 12) return null;
  let encodedBytes = 0;
  const files = [];
  for (const file of candidate.files) {
    if (!file || typeof file.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(file.name) || typeof file.dataBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.dataBase64)) return null;
    encodedBytes += file.dataBase64.length;
    if (encodedBytes > 16_000_000) return null;
    files.push({ name: file.name, data: Buffer.from(file.dataBase64, "base64") });
  }
  return files;
}

function safeCompilePlan(body) {
  if (!body || typeof body !== "object") return null;
  const target = TARGETS.get(body.targetId);
  if (!target || body.boardFqbn !== target.fqbn || typeof body.code !== "string" || body.code.length < 1 || body.code.length > 100_000) return null;
  if (!Array.isArray(body.requiredLibraries) || body.requiredLibraries.length > 32) return null;
  const requiredLibraries = [];
  for (const item of body.requiredLibraries) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const version = item?.version == null ? null : typeof item.version === "string" ? item.version.trim() : "";
    if (!name || name.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9 ._+()/-]*$/.test(name)) return null;
    if (version !== null && (!version || version.length > 40 || !/^[A-Za-z0-9._+-]+$/.test(version))) return null;
    requiredLibraries.push({ name, version });
  }
  const scope = body.scope === "my-builds" || body.scope === "this-lan" ? body.scope : "service";
  return { targetId: body.targetId, target, code: body.code, requiredLibraries, scope };
}

function validCachedCompile(value, plan) {
  if (!value || value.compiled !== true || value.boardFqbn !== plan.target.fqbn || !Array.isArray(value.requiredLibraries)) return false;
  return plan.targetId === "arduino-uno-r3"
    ? typeof value.firmwareHex === "string"
    : Boolean(value.firmwareArtifact && value.firmwareArtifact.targetId === plan.targetId && Array.isArray(value.firmwareArtifact.files));
}

async function readPersistentCompile(key, plan) {
  const path = join(FIRMWARE_CACHE_DIR, `${key}.json`);
  try {
    if (Date.now() - (await stat(path)).mtimeMs > FIRMWARE_CACHE_TTL) {
      await unlink(path).catch(() => undefined);
      return null;
    }
    const value = JSON.parse(await readFile(path, "utf8"));
    return validCachedCompile(value, plan) ? value : null;
  } catch {
    return null;
  }
}

async function writePersistentCompile(key, value) {
  const destination = join(FIRMWARE_CACHE_DIR, `${key}.json`);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(FIRMWARE_CACHE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
    const entries = (await readdir(FIRMWARE_CACHE_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name));
    const candidates = await Promise.all(entries.map(async (entry) => ({
      path: join(FIRMWARE_CACHE_DIR, entry.name),
      mtimeMs: (await stat(join(FIRMWARE_CACHE_DIR, entry.name))).mtimeMs,
    })));
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    await Promise.all(candidates.slice(FIRMWARE_CACHE_LIMIT).map((entry) => unlink(entry.path).catch(() => undefined)));
  } catch {
    await unlink(temporary).catch(() => undefined);
  }
}

async function withCompileSlot(operation) {
  if (activeCompiles >= COMPILE_CONCURRENCY)
    await new Promise((resolve) => compileWaiters.push(resolve));
  activeCompiles += 1;
  try {
    return await operation();
  } finally {
    activeCompiles = Math.max(0, activeCompiles - 1);
    compileWaiters.shift()?.();
  }
}

async function compileFirmware(plan, signal) {
  await ensureCore(plan.target, signal);
  const key = createHash("sha256").update(JSON.stringify({
    version: 2,
    cli: ARDUINO_CLI,
    targetId: plan.targetId,
    boardFqbn: plan.target.fqbn,
    code: plan.code,
    requiredLibraries: plan.requiredLibraries,
  })).digest("hex");
  const cached = compileCache.get(key);
  if (cached) {
    compileCache.delete(key);
    compileCache.set(key, cached);
    return { ...cached, cacheHit: true };
  }
  const pending = compileInflight.get(key);
  if (pending) return { ...(await pending), cacheHit: true };
  const stored = await readPersistentCompile(key, plan);
  if (stored) {
    compileCache.set(key, stored);
    return { ...stored, cacheHit: true };
  }
  const build = withCompileSlot(async () => {
    const workDir = await mkdtemp(join(tmpdir(), "femos-worker-compile-"));
    const sketchDir = join(workDir, "FemosSketch");
    const outputDir = join(workDir, "build");
    try {
      await mkdir(sketchDir);
      await mkdir(outputDir);
      await writeFile(join(sketchDir, "FemosSketch.ino"), plan.code, "utf8");
      for (const library of plan.requiredLibraries) {
        const spec = library.version ? `${library.name}@${library.version}` : library.name;
        await runCommand(["lib", "install", spec], { signal, timeout: 90_000 });
      }
      await runCommand([
        "compile",
        "--jobs",
        `${COMPILE_JOBS}`,
        "--fqbn",
        plan.target.fqbn,
        "--output-dir",
        outputDir,
        sketchDir,
      ], { signal, timeout: plan.targetId === "arduino-uno-r3" ? 90_000 : 210_000 });
      const names = await readdir(outputDir);
      if (plan.targetId === "arduino-uno-r3") {
        const hexName = names.find((name) => name.endsWith(".ino.hex") && !name.includes("with_bootloader"));
        if (!hexName) throw new Error("Arduino CLI did not produce an Uno firmware file.");
        return {
          compiled: true,
          boardFqbn: plan.target.fqbn,
          uploadSupported: "web-serial",
          firmwareHex: await readFile(join(outputDir, hexName), "utf8"),
          requiredLibraries: plan.requiredLibraries,
        };
      }
      const artifactNames = plan.targetId === "esp32-arduino"
        ? names.filter((name) => name.endsWith(".ino.bin") || name.endsWith(".ino.bootloader.bin") || name.endsWith(".ino.partitions.bin") || name === "boot_app0.bin" || name === "flash_args")
        : names.filter((name) => name.endsWith(".elf-zsk.bin"));
      if (artifactNames.length === 0) throw new Error(`Arduino CLI did not produce firmware for ${plan.target.label}.`);
      return {
        compiled: true,
        boardFqbn: plan.target.fqbn,
        uploadSupported: "local-helper",
        firmwareArtifact: {
          targetId: plan.targetId,
          boardFqbn: plan.target.fqbn,
          files: await Promise.all(artifactNames.map(async (name) => ({ name, dataBase64: (await readFile(join(outputDir, name))).toString("base64") }))),
        },
        requiredLibraries: plan.requiredLibraries,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
  compileInflight.set(key, build);
  try {
    const result = await build;
    compileCache.set(key, result);
    await writePersistentCompile(key, result);
    while (compileCache.size > 16) compileCache.delete(compileCache.keys().next().value);
    return { ...result, cacheHit: false };
  } finally {
    if (compileInflight.get(key) === build) compileInflight.delete(key);
  }
}

const server = createServer(async (request, response) => {
  applyCors(request, response);
  if (rejectForbiddenRequest(request, response)) return;
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded)
      controller.abort(new Error("The browser disconnected; upload stopped."));
  });

  try {
    if (request.method === "GET" && request.url === "/v1/health") {
      await runCommand(["version", "--format", "json"], {
        signal: controller.signal,
        timeout: 10_000,
      });
      sendJson(response, 200, {
        ready: true,
        version: VERSION,
        activeUpload,
        activeCompiles,
        capabilities: {
          compilation: [...TARGETS.entries()].map(([targetId, target]) => ({ targetId, boardFqbn: target.fqbn })),
          upload: ["arduino-uno-q", "esp32-arduino"],
          scopes: ["my-builds", "this-lan", ...(SERVICE_COMPILER ? ["public-world"] : [])],
        },
        settings: workerSettings,
      });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/settings") {
      sendJson(response, 200, { settings: workerSettings });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/settings") {
      const settings = safeWorkerSettings(await readJsonBody(request));
      if (!settings) {
        sendJson(response, 400, { error: "Provide valid worker settings." });
        return;
      }
      workerSettings = settings;
      COMPILE_CONCURRENCY = settings.compileConcurrency;
      COMPILE_JOBS = settings.jobsPerCompile;
      await saveWorkerSettings(settings);
      sendJson(response, 200, { settings: workerSettings });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/compile") {
      const plan = safeCompilePlan(await readJsonBody(request));
      if (!plan) {
        sendJson(response, 400, { error: "Provide a valid compiler plan for a supported target." });
        return;
      }
      if (
        (plan.scope === "my-builds" && !workerSettings.useForMyBuilds) ||
        (plan.scope === "this-lan" && !workerSettings.useForLan)
      ) {
        sendJson(response, 503, { error: `Compilation is disabled for ${plan.scope} on this worker.` });
        return;
      }
      try {
        sendJson(response, 200, await compileFirmware(plan, controller.signal));
      } catch (error) {
        const details = error instanceof Error ? error.message : "Compilation failed.";
        sendJson(response, 422, {
          error: details.includes("ENOENT") ? "Arduino CLI is not installed on this worker." : "The generated code did not compile on this worker.",
          diagnostics: details.slice(-8_000),
        });
      }
      return;
    }
    if (request.method === "GET" && request.url === "/v1/boards") {
      sendJson(response, 200, { boards: await listBoards(controller.signal) });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/monitor/stop") {
      const body = await readJsonBody(request);
      if (!activeMonitor || body.monitorId !== activeMonitor.id) {
        sendJson(response, 404, { error: "Serial Monitor is not connected." });
        return;
      }
      stopActiveMonitor();
      sendJson(response, 200, { stopped: true });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/monitor/write") {
      const body = await readJsonBody(request);
      const text = typeof body.text === "string" ? body.text : "";
      if (!activeMonitor || body.monitorId !== activeMonitor.id) {
        sendJson(response, 404, { error: "Serial Monitor is not connected." });
        return;
      }
      if (!text || text.length > 4_096) {
        sendJson(response, 400, { error: "Provide up to 4096 characters of serial input." });
        return;
      }
      activeMonitor.child.stdin.write(text, (error) => {
        if (error) sendJson(response, 500, { error: "Could not write to the serial port." });
        else sendJson(response, 200, { sent: true });
      });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/monitor/start") {
      if (activeUpload) {
        sendJson(response, 409, { error: "Wait for the Arduino upload to finish." });
        return;
      }
      const body = await readJsonBody(request);
      const target = TARGETS.get(body.targetId);
      const port = typeof body.port === "string" ? body.port : "";
      const baudRate = Number(body.baudRate);
      if (!target || !port || ![9600, 19200, 38400, 57600, 115200].includes(baudRate)) {
        sendJson(response, 400, { error: "Choose a supported board, port, and baud rate." });
        return;
      }
      const board = (await listBoards(controller.signal)).find(
        (candidate) => candidate.fqbn === target.fqbn && candidate.address === port,
      );
      if (!board) {
        sendJson(response, 409, { error: `${target.label} is not available on the selected port.` });
        return;
      }
      stopActiveMonitor("Serial Monitor replaced by a new connection.");
      const monitorId = randomUUID();
      const child = spawn(
        ARDUINO_CLI,
        ["monitor", "--quiet", "--raw", "--port", board.address, "--fqbn", target.fqbn, "--config", `baudrate=${baudRate}`],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      activeMonitor = { id: monitorId, child, response };
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      sendEvent(response, {
        type: "connected",
        monitorId,
        message: `Connected to ${board.boardName} at ${baudRate} baud.`,
      });
      const sendOutput = (chunk) => {
        if (!response.writableEnded)
          sendEvent(response, { type: "data", text: chunk.toString("utf8") });
      };
      child.stdout.on("data", sendOutput);
      child.stderr.on("data", sendOutput);
      child.on("error", (error) => {
        if (activeMonitor?.id === monitorId) activeMonitor = null;
        if (!response.writableEnded) {
          sendEvent(response, { type: "error", message: error.message });
          response.end();
        }
      });
      child.on("exit", (code) => {
        if (activeMonitor?.id === monitorId) activeMonitor = null;
        if (!response.writableEnded) {
          sendEvent(response, {
            type: "disconnected",
            message: code === 0 ? "Serial Monitor disconnected." : "Serial Monitor process stopped unexpectedly.",
          });
          response.end();
        }
      });
      controller.signal.addEventListener(
        "abort",
        () => {
          if (activeMonitor?.id === monitorId) stopActiveMonitor();
        },
        { once: true },
      );
      return;
    }
    const isProvisioning = request.method === "POST" && request.url === "/v1/provision";
    if (request.method !== "POST" || (request.url !== "/v1/upload" && !isProvisioning)) {
      sendJson(response, 404, { error: "Local uploader endpoint not found." });
      return;
    }
    if (activeUpload) {
      sendJson(response, 409, { error: "Another Arduino upload is already running." });
      return;
    }
    stopActiveMonitor("Serial Monitor paused for upload.");

    const body = await readJsonBody(request);
    const target = TARGETS.get(body.targetId);
    const artifactFiles = target
      ? safeFirmwareArtifact(body.firmwareArtifact, body.targetId, target.fqbn)
      : null;
    const provisioningSettings = isProvisioning ? safeProvisioningSettings(body) : null;
    if (!target || !artifactFiles || (isProvisioning && (body.targetId !== "esp32-arduino" || !provisioningSettings))) {
      sendJson(response, 400, { error: isProvisioning ? "Provide valid ESP32 setup firmware and wireless settings." : "Choose a supported board and provide a valid FEMOS firmware bundle." });
      return;
    }
    const uploadMode = body.mode === "ota" ? "ota" : "usb";
    const requestedPort = typeof body.port === "string" ? body.port : null;
    const otaPort = uploadMode === "ota" ? safeOtaPort(requestedPort) : null;
    const otaPassword = typeof body.otaPassword === "string" ? body.otaPassword : "";
    let uploadPort = otaPort;
    let boardName = otaPort;
    if (uploadMode === "ota") {
      if (body.targetId !== "esp32-arduino" || !otaPort || otaPassword.length < 8 || otaPassword.length > 64) {
        sendJson(response, 400, { error: "Provide a valid ESP32 .local name or IP address and OTA password." });
        return;
      }
    } else {
      const matchingBoards = (await listBoards(controller.signal)).filter(
        (board) => board.fqbn === target.fqbn,
      );
      const board = requestedPort
        ? matchingBoards.find((candidate) => candidate.address === requestedPort)
        : matchingBoards.length === 1
          ? matchingBoards[0]
          : null;
      if (!board) {
        sendJson(response, 409, {
          error:
            matchingBoards.length === 0
              ? `${target.label} is not connected or has not finished booting.`
              : requestedPort
                ? `The selected ${target.label} port is no longer available. Refresh boards and choose it again.`
              : "More than one matching board is connected. Select a board first.",
          boards: matchingBoards,
        });
        return;
      }
      uploadPort = board.address;
      boardName = board.boardName;
    }

    activeUpload = true;
    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const workDir = await mkdtemp(join(tmpdir(), "femos-uploader-"));
    const sketchDir = join(workDir, "FemosSketch");
    const buildDir = join(workDir, "build");
    try {
      await mkdir(sketchDir);
      await mkdir(buildDir);
      await writeFile(join(sketchDir, "FemosSketch.ino"), "void setup() {}\nvoid loop() {}\n", "utf8");
      for (const file of artifactFiles) await writeFile(join(buildDir, file.name), file.data);
      sendEvent(response, { type: "progress", progress: 65, message: `Firmware ready for ${target.label}.` });
      sendEvent(response, { type: "progress", progress: 70, message: `Uploading to ${boardName}…` });
      if (uploadMode === "ota") {
        await ensureCore(target, controller.signal);
        await runCommand(buildEspOtaUploadArgs({
          fqbn: target.fqbn,
          inputDir: buildDir,
          host: uploadPort,
          password: otaPassword,
          sketchDir,
        }), { signal: controller.signal, timeout: 120_000 });
      } else {
        await ensureCore(target, controller.signal);
        await runCommand(
          buildUsbUploadArgs({
            fqbn: target.fqbn,
            inputDir: buildDir,
            port: uploadPort,
            sketchDir,
          }),
          { signal: controller.signal, timeout: 120_000 },
        );
      }
      if (isProvisioning) {
        sendEvent(response, { type: "progress", progress: 88, message: "Sending wireless settings privately over USB…" });
        await configureEsp32OverSerial({
          port: uploadPort,
          fqbn: target.fqbn,
          settings: provisioningSettings,
          signal: controller.signal,
        });
      }
      sendEvent(response, { type: "complete", progress: 100, message: `Upload complete. ${target.label} is running the new sketch.` });
      response.end();
    } catch (error) {
      console.error(`[upload] ${request.url ?? "unknown"}: ${error instanceof Error ? error.message.slice(-2_000) : "upload failed"}`);
      if (!response.writableEnded) {
        sendEvent(response, {
          type: "error",
          message: publicUploadError(error, target.label),
        });
        response.end();
      }
    } finally {
      activeUpload = false;
      await rm(workDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (!response.headersSent)
      sendJson(response, 500, {
        error:
          error?.code === "ENOENT"
            ? "Arduino CLI is not installed or is not available on PATH."
            : error instanceof Error
              ? error.message.slice(-8_000)
              : "The local uploader failed.",
      });
    else if (!response.writableEnded) response.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FEMOS Local Uploader ${VERSION} listening on http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopActiveMonitor("Local uploader stopped.");
    server.close(() => process.exit(0));
  });
