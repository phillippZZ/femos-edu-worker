import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digestManufacturing, digestPlan, digestUpload, startRemoteExecutionClient } from "../src/remote-execution.mjs";
import { sliceStl } from "../src/manufacturing.mjs";
import { fileURLToPath } from "node:url";

test("outbound enrolled Worker claims a typed compile and reports its result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "femos-remote-worker-test-"));
  const identityPath = join(dir, "identity.json");
  const credential = `femos_worker_${"a".repeat(43)}`;
  const plan = { targetId: "arduino-uno-r3", boardFqbn: "arduino:avr:uno",
    code: "void setup() {}\nvoid loop() {}", requiredLibraries: [] };
  await writeFile(identityPath, JSON.stringify({ workerId: "worker-1", credential,
    serverUrl: "https://femos.example" }), { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  const requests = [];
  let report;
  const reported = new Promise((resolve) => { report = resolve; });
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    requests.push({ path, body, authorization: init.headers.Authorization });
    let response = {};
    if (path.endsWith("/claim")) response = { claim: { executionId: "execution-1", attempt: 1,
      leaseToken: `femos_lease_${"b".repeat(43)}`, inputDigest: digestPlan(plan), plan } };
    if (path.endsWith("/renew")) response = { cancellationRequested: false };
    if (path.endsWith("/result")) report();
    return { ok: true, json: async () => response };
  };
  let client;
  try {
    client = await startRemoteExecutionClient({ identityPath, version: "2.3.0",
      safePlan: (input) => ({ ...input, target: { fqbn: input.boardFqbn } }),
      compile: async () => ({ compiled: true, boardFqbn: plan.boardFqbn,
        firmwareHex: ":00000001FF", requiredLibraries: [] }), isPaused: () => false });
    await Promise.race([reported, new Promise((_, reject) => setTimeout(() => reject(new Error("Result not reported.")), 1000))]);
    assert.equal(client.enabled, true);
    assert.ok(requests.some((item) => item.path.endsWith("/heartbeat")));
    const heartbeat = requests.find((item) => item.path.endsWith("/heartbeat"));
    assert.deepEqual(heartbeat.body.capability[0].sourceModes, ["code", "sourceProject"]);
    assert.ok(heartbeat.body.capability[0].supportedTargets.includes("waveshare-esp32-s3-watch"));
    assert.ok(requests.some((item) => item.path.endsWith("/claim")));
    assert.ok(requests.some((item) => item.path.endsWith("/result") && item.body.result.firmwareHex === ":00000001FF"));
    assert.ok(requests.every((item) => item.authorization === `Bearer ${credential}`));
    assert.equal(digestPlan(plan), createHash("sha256").update(JSON.stringify({ operation: "arduino.compile", version: 1, plan })).digest("hex"));
  } finally {
    client?.stop();
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("sourceProject claim digests are stable across file ordering", () => {
  const first = { targetId: "arduino-uno-r3", boardFqbn: "arduino:avr:uno", requiredLibraries: [], sourceProject: {
    entryFile: "main.ino", files: [
      { path: "main.ino", content: "void setup() {}" },
      { path: "femos_blink_test.h", content: "void blinkTest();" },
    ],
  } };
  const second = { ...first, sourceProject: { ...first.sourceProject, files: [...first.sourceProject.files].reverse() } };
  assert.equal(digestPlan(first), digestPlan(second));
});

test("outbound Worker executes a real reviewed STL slice and returns printable bytes", async (t) => {
  const slicer = process.env.FEMOS_TEST_PRUSASLICER_PATH || "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer";
  try { await access(slicer); } catch { t.skip("PrusaSlicer not installed."); return; }
  const dir = await mkdtemp(join(tmpdir(), "femos-remote-slice-test-"));
  const identityPath = join(dir, "identity.json");
  const model = await readFile(fileURLToPath(new URL("./fixtures/tetrahedron.stl", import.meta.url)));
  const profile = fileURLToPath(new URL("../profiles/generic-pla-0.4.ini", import.meta.url));
  const artifactDigest = createHash("sha256").update(model).digest("hex");
  const slice = { artifactId: "artifact_12345678", artifactDigest, profileId: "generic-pla-0.4", materialId: "PLA" };
  await writeFile(identityPath, JSON.stringify({ workerId: "worker-slice", credential: `femos_worker_${"s".repeat(43)}`,
    serverUrl: "https://femos.example" }), { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  let claims = 0;
  let completed;
  const reported = new Promise((resolve) => { completed = resolve; });
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/input")) return { ok: true, arrayBuffer: async () => model,
      headers: new Headers({ "X-FEMOS-Artifact-Digest": artifactDigest, "Content-Length": String(model.length) }) };
    const body = JSON.parse(init.body);
    if (path.endsWith("/claim")) return { ok: true, json: async () => ({ claim: claims++ === 0
      ? { operation: "manufacturing.slice", executionId: "execution-slice", attempt: 1,
        leaseToken: `femos_lease_${"l".repeat(43)}`, inputDigest: digestManufacturing("manufacturing.slice", slice), slice } : null }) };
    if (path.endsWith("/result")) { completed(body.result); }
    return { ok: true, json: async () => ({ cancellationRequested: false }) };
  };
  let client;
  try {
    client = await startRemoteExecutionClient({ identityPath, version: "2.5.0",
      safePlan: (value) => value, compile: async () => { throw new Error("Unexpected Arduino compile"); },
      sliceAvailable: async () => true,
      slice: async (bytes, signal) => sliceStl(bytes, { executable: slicer, profile }, signal),
      isPaused: () => false });
    const result = await Promise.race([reported, new Promise((_, reject) => setTimeout(() => reject(new Error("Slice not reported.")), 5_000))]);
    const output = Buffer.from(result.gcodeBase64, "base64");
    assert.ok(output.length > 1_000);
    assert.equal(result.digest, createHash("sha256").update(output).digest("hex"));
  } finally {
    client?.stop(); globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("simulated physical dispatch reports uncertainty after effect start without a second claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "femos-remote-print-test-"));
  const identityPath = join(dir, "identity.json");
  await writeFile(identityPath, JSON.stringify({ workerId: "worker-print", credential: `femos_worker_${"p".repeat(43)}`,
    serverUrl: "https://femos.example" }), { mode: 0o600 });
  const gcode = Buffer.from("; printable\nG28\nG1 X10 Y10\n");
  const artifactDigest = createHash("sha256").update(gcode).digest("hex");
  const print = { printRequestId: "printrequest123", deviceId: "device_12345678",
    artifactId: "artifact_12345678", artifactDigest, profileId: "generic-pla-0.4",
    identityFingerprint: "a".repeat(64), targetId: "simulated-printer-v1" };
  let claims = 0;
  let physicalStarts = 0;
  let failure;
  const reported = new Promise((resolve) => { failure = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/input")) return { ok: true, arrayBuffer: async () => gcode,
      headers: new Headers({ "X-FEMOS-Artifact-Digest": artifactDigest, "Content-Length": String(gcode.length) }) };
    const body = JSON.parse(init.body);
    if (path.endsWith("/claim")) return { ok: true, json: async () => ({ claim: claims++ === 0
      ? { operation: "printer.simulate", executionId: "execution-print", attempt: 1,
        leaseToken: `femos_lease_${"q".repeat(43)}`, inputDigest: digestManufacturing("printer.simulate", print), print } : null }) };
    if (path.endsWith("/failure")) failure(body);
    return { ok: true, json: async () => ({ cancellationRequested: false }) };
  };
  let client;
  try {
    client = await startRemoteExecutionClient({ identityPath, version: "2.5.0",
      safePlan: (value) => value, compile: async () => { throw new Error("Unexpected compile"); },
      simulate: async (_bytes, _snapshot, _signal, markEffect) => {
        physicalStarts++; markEffect(); throw new Error("simulated connection lost");
      }, simulatedPrinter: true, isPaused: () => false });
    const body = await Promise.race([reported, new Promise((_, reject) => setTimeout(() => reject(new Error("Physical failure not reported.")), 2_000))]);
    assert.equal(physicalStarts, 1);
    assert.equal(body.effectStarted, true);
    assert.match(body.diagnostics, /connection lost/);
  } finally {
    client?.stop(); globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("typed upload validates firmware and reports an uncertain physical outcome without retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "femos-upload-worker-test-"));
  const identityPath = join(dir, "identity.json");
  const credential = `femos_worker_${"c".repeat(43)}`;
  await writeFile(identityPath, JSON.stringify({ workerId: "worker-2", credential,
    serverUrl: "https://femos.example" }), { mode: 0o600 });
  const firmware = Buffer.from(JSON.stringify({ compiled: true, boardFqbn: "arduino:zephyr:unoq",
    firmwareArtifact: { targetId: "arduino-uno-q", boardFqbn: "arduino:zephyr:unoq", files: [] } }));
  const artifactDigest = createHash("sha256").update(firmware).digest("hex");
  const upload = { deviceId: "device_12345678", artifactId: "artifact_12345678",
    artifactDigest, identityFingerprint: "d".repeat(64), targetId: "arduino-uno-q", mode: "usb" };
  let claimCount = 0;
  let physicalCalls = 0;
  const failures = [];
  let report;
  const reported = new Promise((resolve) => { report = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/firmware")) return { ok: true,
      arrayBuffer: async () => firmware, headers: new Headers({ "X-FEMOS-Artifact-Digest": artifactDigest }) };
    const body = JSON.parse(init.body);
    if (path.endsWith("/claim")) return { ok: true, json: async () => ({ claim: claimCount++ === 0
      ? { operation: "arduino.upload", executionId: "execution-2", attempt: 1,
        leaseToken: `femos_lease_${"e".repeat(43)}`, inputDigest: digestUpload(upload), upload } : null }) };
    if (path.endsWith("/failure")) { failures.push(body); report(); }
    return { ok: true, json: async () => ({ cancellationRequested: false }) };
  };
  let client;
  try {
    client = await startRemoteExecutionClient({ identityPath, version: "2.3.0", safePlan: (value) => value,
      compile: async () => { throw new Error("Unexpected compile"); },
      discover: async () => [], upload: async (_snapshot, _artifact, _signal, markPhysicalStart) => {
        physicalCalls++; markPhysicalStart(); throw new Error("USB disconnected during flashing");
      }, isPaused: () => false });
    await Promise.race([reported, new Promise((_, reject) => setTimeout(() => reject(new Error("Failure not reported.")), 1500))]);
    assert.equal(physicalCalls, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].effectStarted, true);
    assert.match(failures[0].diagnostics, /USB disconnected/);
  } finally {
    client?.stop(); globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
