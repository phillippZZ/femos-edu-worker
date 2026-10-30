import assert from "node:assert/strict";
import { test } from "node:test";
import { hasCompleteEsp32ArtifactFiles, materializedSourceProjectFiles, parseRequiredLibraries, parseSourceMode, parseSourceProject } from "../src/compile-contract.mjs";

test("ESP32 artifact validation requires the complete reviewed flash layout", () => {
  const files = [
    "flash_args",
    "boot_app0.bin",
    "FemosSketch.ino.bin",
    "FemosSketch.ino.bootloader.bin",
    "FemosSketch.ino.partitions.bin",
  ];
  assert.equal(hasCompleteEsp32ArtifactFiles(files), true);
  for (const required of files) {
    assert.equal(
      hasCompleteEsp32ArtifactFiles(files.filter((name) => name !== required)),
      false,
      `${required} must not be optional`,
    );
  }
  assert.equal(hasCompleteEsp32ArtifactFiles(files.map((name) => ({ name }))), true);
});

test("Waveshare compile artifacts contain every file required by flash_args", () => {
  const firmwareArtifact = {
    targetId: "waveshare-esp32-s3-watch",
    boardFqbn: "esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,PSRAM=opi,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB",
    files: [
      "flash_args",
      "boot_app0.bin",
      "FemosSketch.ino.bin",
      "FemosSketch.ino.bootloader.bin",
      "FemosSketch.ino.partitions.bin",
    ].map((name) => ({ name, dataBase64: "AA==" })),
  };
  assert.equal(firmwareArtifact.targetId, "waveshare-esp32-s3-watch");
  assert.equal(hasCompleteEsp32ArtifactFiles(firmwareArtifact.files), true);
  assert.deepEqual(firmwareArtifact.files.map((file) => file.name), [
    "flash_args",
    "boot_app0.bin",
    "FemosSketch.ino.bin",
    "FemosSketch.ino.bootloader.bin",
    "FemosSketch.ino.partitions.bin",
  ]);
});

test("sourceProject validation accepts one flat entry sketch and modules", () => {
  const value = parseSourceProject({ entryFile: "main.ino", files: [
    { path: "main.ino", content: "void setup() {}" },
    { path: "femos_blink_test.h", content: "void blinkTest();" },
    { path: "femos_blink_test.cpp", content: "void blinkTest() {}" },
  ] });
  assert.deepEqual(value.files.map((file) => file.path), ["femos_blink_test.cpp", "femos_blink_test.h", "main.ino"]);
  assert.equal(materializedSourceProjectFiles(value)[2].path, "FemosSketch.ino");
});

test("sourceProject validation rejects traversal, nested, duplicate, and unsupported paths", () => {
  for (const path of ["../main.ino", "/tmp/main.ino", "main\\ino", ".main.ino", "folder/main.ino", "main.txt"]) {
    assert.equal(parseSourceProject({ entryFile: path, files: [{ path, content: "void setup() {}" }] }), null);
  }
  assert.equal(parseSourceProject({ entryFile: "main.ino", files: [
    { path: "main.ino", content: "void setup() {}" },
    { path: "MAIN.INO", content: "void loop() {}" },
  ] }), null);
});

test("source mode requires exactly one of code and sourceProject", () => {
  assert.equal(parseSourceMode({ code: "void setup() {}" }).mode, "code");
  assert.equal(parseSourceMode({ sourceProject: { entryFile: "main.ino", files: [{ path: "main.ino", content: "void setup() {}" }] } }).mode, "sourceProject");
  assert.equal(parseSourceMode({}), null);
  assert.equal(parseSourceMode({ code: "void setup() {}", sourceProject: {} }), null);
});

test("required library validation preserves the existing bounded syntax", () => {
  assert.deepEqual(parseRequiredLibraries([{ name: "Servo", version: null }]), [{ name: "Servo", version: null }]);
  assert.equal(parseRequiredLibraries([{ name: "bad;command", version: null }]), null);
});
