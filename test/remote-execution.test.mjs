import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digestPlan, startRemoteExecutionClient } from "../src/remote-execution.mjs";

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
