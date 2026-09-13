import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEspOtaArgs, buildUsbUploadArgs } from "../src/upload-command.mjs";

describe("buildUploadArgs", () => {
  it("builds Arduino CLI arguments for ESP32 OTA upload", () => {
    assert.deepEqual(
      buildEspOtaArgs({
        scriptPath: "/arduino/espota.py",
        host: "femos-esp32.local",
        password: "safe-test-password",
        firmwarePath: "/tmp/build/FemosSketch.ino.bin",
      }), [
      "/arduino/espota.py",
      "-r",
      "-i",
      "femos-esp32.local",
      "-p",
      "3232",
      "--auth=safe-test-password",
      "-f",
      "/tmp/build/FemosSketch.ino.bin",
    ]);
  });

  it("keeps USB uploads on the serial upload recipe", () => {
    const args = buildUsbUploadArgs({
      fqbn: "esp32:esp32:esp32",
      inputDir: "/tmp/build",
      port: "/dev/cu.usbserial-0001",
      sketchDir: "/tmp/FemosUpload",
    });

    assert.ok(args.includes("/dev/cu.usbserial-0001"));
    assert.ok(!args.includes("--upload-field"));
  });

  it("runs the Windows ESP32 OTA executable without a script argument", () => {
    const args = buildEspOtaArgs({
      scriptPath: null,
      host: "192.168.1.42",
      password: "safe-test-password",
      firmwarePath: "C:\\build\\FemosSketch.ino.bin",
    });

    assert.equal(args[0], "-r");
    assert.ok(args.includes("192.168.1.42"));
  });
});
