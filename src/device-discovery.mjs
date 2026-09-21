import { createHash } from "node:crypto";

const FQBNS = new Map([
  ["arduino:avr:uno", "arduino-uno-r3"],
  ["arduino:zephyr:unoq", "arduino-uno-q"],
  ["esp32:esp32:esp32", "esp32-arduino"],
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Arduino CLI observations are not enrollment or proof of ownership. */
export function parseDeviceObservations(output) {
  const parsed = typeof output === "string" ? JSON.parse(output) : output;
  const ports = Array.isArray(parsed?.detected_ports) ? parsed.detected_ports : [];
  const observations = [];
  for (const entry of ports) {
    const port = entry?.port;
    if (port?.protocol !== "serial" || typeof port.address !== "string") continue;
    const properties = port.properties && typeof port.properties === "object" ? port.properties : {};
    const boards = Array.isArray(entry.matching_boards) ? entry.matching_boards : [];
    const matches = boards.filter((board) => FQBNS.has(board?.fqbn));
    // Arduino CLI often cannot identify a generic ESP32 USB-serial adapter.
    if (!matches.length && /usb/i.test(String(port.protocol_label ?? "")) &&
        /(?:usbserial|ttyUSB|ttyACM|cu\.w(ch|CH)|cp210)/i.test(port.address)) {
      matches.push({ name: "ESP32-compatible USB serial", fqbn: "esp32:esp32:esp32" });
    }
    const vid = String(properties.vid ?? "").trim().toLowerCase();
    const pid = String(properties.pid ?? "").trim().toLowerCase();
    const serial = String(properties.serialNumber ?? properties.serial_number ?? "").trim();
    for (const board of matches) {
      const targetId = FQBNS.get(board.fqbn);
      const strong = Boolean(vid && pid && serial);
      const fingerprint = strong ? digest(`usb:${vid}:${pid}:${serial}`) : null;
      observations.push({
        targetId,
        identityKind: strong ? "USB_SERIAL" : "EXPLICIT_PAIRING",
        fingerprint,
        observationKey: digest(`observation:${targetId}:${fingerprint ?? port.address}`),
        label: String(board.name ?? "Arduino-compatible board").slice(0, 100),
        // Local-only. Never include the address in a heartbeat or persisted server row.
        address: port.address,
      });
    }
  }
  return observations.slice(0, 20);
}

/** Resolve again immediately before a physical operation; never trust an old port. */
export function resolveAttachedBoard(observations, { targetId, fingerprint }) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint ?? "")) throw new Error("This Device needs verified USB identity before Worker upload.");
  const matches = observations.filter((item) => item.targetId === targetId && item.fingerprint === fingerprint);
  if (matches.length !== 1) throw new Error("The selected Device is disconnected or ambiguous. Refresh discovery before uploading.");
  return matches[0];
}

export function publicDeviceObservations(observations) {
  return observations.map(({ address: _address, ...safe }) => safe);
}
