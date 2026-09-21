import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeviceObservations, publicDeviceObservations, resolveAttachedBoard } from "../src/device-discovery.mjs";

const sighting = (address, serialNumber) => ({ detected_ports: [{
  port: { address, protocol: "serial", protocol_label: "Serial Port (USB)",
    properties: { vid: "0x2341", pid: "0x0078", ...(serialNumber ? { serialNumber } : {}) } },
  matching_boards: [{ name: "Arduino UNO Q", fqbn: "arduino:zephyr:unoq" }],
}] });

test("USB serial identifies the same Device after a port change", () => {
  const first = parseDeviceObservations(sighting("/dev/cu.usbmodem1", "1016350030"))[0];
  const moved = parseDeviceObservations(sighting("/dev/cu.usbmodem9", "1016350030"))[0];
  assert.equal(first.fingerprint, moved.fingerprint);
  assert.equal(first.observationKey, moved.observationKey);
  assert.equal(resolveAttachedBoard([moved], first).address, "/dev/cu.usbmodem9");
  assert.equal(JSON.stringify(publicDeviceObservations([first])).includes("usbmodem"), false);
});

test("weak identity needs explicit pairing and cannot authorize upload", () => {
  const weak = parseDeviceObservations(sighting("/dev/cu.usbmodem1"))[0];
  assert.equal(weak.identityKind, "EXPLICIT_PAIRING");
  assert.equal(weak.fingerprint, null);
  assert.throws(() => resolveAttachedBoard([weak], weak), /verified USB identity/);
});

test("a different serial number cannot replace the enrolled board", () => {
  const expected = parseDeviceObservations(sighting("/dev/cu.usbmodem1", "one"))[0];
  const replacement = parseDeviceObservations(sighting("/dev/cu.usbmodem1", "two"))[0];
  assert.throws(() => resolveAttachedBoard([replacement], expected), /disconnected or ambiguous/);
});
