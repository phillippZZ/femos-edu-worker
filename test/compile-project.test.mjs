import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function hasArduinoCli() {
  try { execFileSync(process.env.ARDUINO_CLI_PATH || "arduino-cli", ["version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

test("flat materialized sourceProject and legacy code compile through Arduino CLI", async (t) => {
  if (!hasArduinoCli()) { t.skip("arduino-cli is not installed."); return; }
  const dataDir = await mkdtemp(join(tmpdir(), "femos-worker-contract-test-"));
  const sketchDir = join(dataDir, "FemosSketch");
  const outputDir = join(dataDir, "build");
  const cacheDir = join(dataDir, "arduino-cache");
  await mkdir(sketchDir);
  await mkdir(outputDir);
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sourceProject = {
    entryFile: "main.ino",
    files: [
      { path: "main.ino", content: '#include "femos_blink_test.h"\nvoid setup() { blinkTest(); }\nvoid loop() {}\n' },
      { path: "femos_blink_test.h", content: "#pragma once\nvoid blinkTest();\n" },
      { path: "femos_blink_test.cpp", content: '#include "femos_blink_test.h"\n#include <Arduino.h>\nvoid blinkTest() { pinMode(LED_BUILTIN, OUTPUT); digitalWrite(LED_BUILTIN, HIGH); }\n' },
    ],
  };
  const compile = async (files, requiredLibraries = []) => {
    await rm(sketchDir, { recursive: true, force: true }); await mkdir(sketchDir);
    await rm(outputDir, { recursive: true, force: true }); await mkdir(outputDir);
    await Promise.all(files.map((file) => writeFile(join(sketchDir, file.path === "main.ino" ? "FemosSketch.ino" : file.path), file.content)));
    for (const library of requiredLibraries) await execFileAsync(process.env.ARDUINO_CLI_PATH || "arduino-cli", ["lib", "install", library.version ? `${library.name}@${library.version}` : library.name], { timeout: 90_000 });
    await execFileAsync(process.env.ARDUINO_CLI_PATH || "arduino-cli", ["compile", "--jobs", "2", "--build-cache-path", cacheDir, "--fqbn", "arduino:avr:uno", "--output-dir", outputDir, sketchDir], { timeout: 120_000 });
    const hex = (await readdir(outputDir)).find((name) => name.endsWith(".ino.hex") && !name.includes("with_bootloader"));
    assert.ok(hex);
    return readFile(join(outputDir, hex), "utf8");
  };
  const multi = await compile(sourceProject.files);
  assert.match(multi, /^:/);
  const external = await compile([{ path: "main.ino", content:
    '#include <Servo.h>\nServo servo;\nvoid setup() { servo.attach(9); }\nvoid loop() {}\n' }], [{ name: "Servo", version: null }]);
  assert.match(external, /^:/);
  const legacy = await compile([{ path: "main.ino", content: "void setup() {}\nvoid loop() {}\n" }]);
  assert.match(legacy, /^:/);
});
