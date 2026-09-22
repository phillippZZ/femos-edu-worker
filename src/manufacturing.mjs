import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

export const SLICE_PROFILE = "generic-pla-0.4";
export const SIMULATED_PRINTER_TARGET = "simulated-printer-v1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Installation is deliberate. No caller-controlled executable, path or slicer flags. */
export async function slicerConfiguration() {
  const executable = process.env.FEMOS_PRUSASLICER_PATH;
  const profile = process.env.FEMOS_PRUSASLICER_PROFILE_PATH;
  if (!executable || !profile || !isAbsolute(executable) || !isAbsolute(profile)) return null;
  try {
    await Promise.all([access(executable), access(profile)]);
    const cfg = await stat(profile);
    if (!cfg.isFile() || cfg.size < 50 || cfg.size > 1_000_000) return null;
    return { executable, profile };
  } catch { return null; }
}

export async function sliceStl(bytes, { executable, profile }, signal) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 84 || bytes.length > 10_000_000) throw new Error("Invalid bounded STL input.");
  const directory = await mkdtemp(join(tmpdir(), "femos-slice-"));
  const source = join(directory, "input.stl");
  const output = join(directory, "output.gcode");
  try {
    await writeFile(source, bytes, { mode: 0o600 });
    const args = ["--load", profile, "--export-gcode", "--output", output, source];
    const diagnostics = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"],
        signal, env: { ...process.env, HOME: process.env.HOME } });
      let captured = "";
      const take = (data) => { captured = (captured + String(data)).slice(-8_000); };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const timer = setTimeout(() => child.kill("SIGKILL"), 8 * 60_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve(captured) : reject(new Error(`PrusaSlicer exited ${code}: ${captured}`)); });
    });
    const file = await stat(output);
    if (!file.isFile() || file.size < 100 || file.size > 12_000_000) throw new Error("Slicer did not produce a bounded printable artifact.");
    const gcode = await readFile(output);
    const text = gcode.subarray(0, Math.min(gcode.length, 20_000)).toString("utf8");
    if (!/G(?:0|1|28|29|92)\b|M(?:104|109|140|190)\b/m.test(text)) throw new Error("Slicer output lacks expected machine commands.");
    const time = /;\s*estimated printing time[^=]*=\s*([^\r\n]+)/i.exec(gcode.toString("utf8"))?.[1] ?? null;
    const material = /;\s*filament used \[g\]\s*=\s*([0-9.]+)/i.exec(gcode.toString("utf8"))?.[1] ?? null;
    const grams = material ? Number(material) : null;
    const hour = time ? Number(/(\d+)h/.exec(time)?.[1] ?? 0) : 0;
    const minute = time ? Number(/(\d+)m/.exec(time)?.[1] ?? 0) : 0;
    const second = time ? Number(/(\d+)s/.exec(time)?.[1] ?? 0) : 0;
    const estimatedSeconds = time && hour + minute + second > 0 ? hour * 3600 + minute * 60 + second : null;
    return { gcodeBase64: gcode.toString("base64"), digest: digest(gcode),
      estimatedSeconds, estimatedGrams: grams && Number.isFinite(grams) && grams > 0 ? grams : null,
      diagnostics: String(diagnostics).slice(-1_000) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Test-only physical-effect adapter; no port, printer IP, or vendor credentials. */
export async function simulatePrint(gcode, print, signal, onEffectStarted) {
  if (!Buffer.isBuffer(gcode) || !gcode.length || gcode.length > 12_000_000) throw new Error("Invalid printable input.");
  if (digest(gcode) !== print.artifactDigest) throw new Error("Printable Artifact checksum mismatch.");
  if (print.targetId !== SIMULATED_PRINTER_TARGET || print.profileId !== SLICE_PROFILE) throw new Error("Unsupported simulated printer target.");
  if (signal.aborted) throw signal.reason;
  const jobId = `sim-${print.printRequestId}`;
  onEffectStarted();
  for (let step = 0; step < 3; step++) {
    if (signal.aborted) throw signal.reason;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 350);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }
  return { simulated: true, jobId };
}
