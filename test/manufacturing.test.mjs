import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { sliceStl, simulatePrint } from "../src/manufacturing.mjs";

const fixture = fileURLToPath(new URL("./fixtures/tetrahedron.stl", import.meta.url));
const profile = fileURLToPath(new URL("../profiles/generic-pla-0.4.ini", import.meta.url));
const slicer = process.env.FEMOS_TEST_PRUSASLICER_PATH || "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer";

test("real tetrahedron STL is sliced by PrusaSlicer into a digestible G-code artifact", async (t) => {
  try { await access(slicer); } catch { t.skip("PrusaSlicer is not installed on this test host."); return; }
  const result = await sliceStl(await readFile(fixture), { executable: slicer, profile }, new AbortController().signal);
  const bytes = Buffer.from(result.gcodeBase64, "base64");
  assert.ok(bytes.length > 1_000);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), result.digest);
  assert.match(bytes.toString("utf8"), /G1/);
  assert.ok(result.estimatedSeconds === null || result.estimatedSeconds > 0);
  assert.ok(result.estimatedGrams === null || result.estimatedGrams > 0);
});

test("simulated printer validates exact artifact and reports effect start", async () => {
  const bytes = Buffer.from("; slice\nG28\nG1 X10 Y10\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const snapshot = { printRequestId: "printrequest123", targetId: "simulated-printer-v1",
    profileId: "generic-pla-0.4", artifactDigest: digest };
  let starts = 0;
  const result = await simulatePrint(bytes, snapshot, new AbortController().signal, () => { starts++; });
  assert.equal(starts, 1);
  assert.deepEqual(result, { simulated: true, jobId: "sim-printrequest123" });
  await assert.rejects(() => simulatePrint(bytes, { ...snapshot, artifactDigest: "0".repeat(64) },
    new AbortController().signal, () => {}), /checksum/);
});

test("simulated printer abort after effect start is not a success", async () => {
  const bytes = Buffer.from("G28\n");
  const controller = new AbortController();
  let started = false;
  await assert.rejects(() => simulatePrint(bytes, { printRequestId: "printrequest456",
    targetId: "simulated-printer-v1", profileId: "generic-pla-0.4",
    artifactDigest: createHash("sha256").update(bytes).digest("hex") },
  controller.signal, () => { started = true; controller.abort(new Error("connection lost")); }), /connection lost/);
  assert.equal(started, true);
});
