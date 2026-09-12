import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEspOtaUploadArgs, buildUsbUploadArgs } from "../src/upload-command.mjs";

describe("buildUploadArgs", () => {
  it("builds Arduino CLI arguments for ESP32 OTA upload", () => {
    assert.deepEqual(
      buildEspOtaUploadArgs({
        fqbn: "esp32:esp32:esp32",
        inputDir: "/tmp/build",
        host: "femos-esp32.local",
        password: "safe-test-password",
        sketchDir: "/tmp/FemosSketch",
      }), [
      "upload",
      "--port", "femos-esp32.local",
      "--protocol", "network",
      "--fqbn", "esp32:esp32:esp32",
      "--input-dir", "/tmp/build",
      "--upload-field", "password=safe-test-password",
      "/tmp/FemosSketch",
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
});
