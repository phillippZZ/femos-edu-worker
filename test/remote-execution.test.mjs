import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digestPlan, digestUpload, startRemoteExecutionClient } from "../src/remote-execution.mjs";

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
