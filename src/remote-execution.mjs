import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { platform } from "node:os";

const CAPABILITY = "arduino.compile@1";
const ADAPTER_VERSION = "1";
const TARGETS = ["arduino-uno-r3", "arduino-uno-q", "esp32-arduino"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function endpoint(base) {
  if (!base) return null;
  const url = new URL(base);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("Remote FEMOS must use HTTPS or loopback HTTP.");
  return url.toString().replace(/\/$/, "");
}

async function workerRequest(base, credential, path, payload, timeoutMs = 20_000) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: {
    Authorization: `Bearer ${credential}`, "Content-Type": "application/json",
  }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? `FEMOS returned HTTP ${response.status}.`), { status: response.status });
  return body;
}

export function digestPlan(plan) {
  return createHash("sha256").update(JSON.stringify({ operation: "arduino.compile", version: 1, plan })).digest("hex");
}

/** Outbound-only durable compile. Existing loopback upload/monitor APIs stay separate. */
export async function startRemoteExecutionClient({ baseUrl, identityPath, version, safePlan, compile, isPaused, onEvent = () => {} }) {
  let identity;
  try {
    const metadata = await stat(identityPath);
    if (platform() !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Worker identity file permissions are too broad.");
    identity = JSON.parse(await readFile(identityPath, "utf8"));
  } catch (error) {
    onEvent(error?.code === "ENOENT" ? "No enrolled identity; remote compile polling is disabled."
      : "Worker identity could not be loaded securely; remote compile polling is disabled.");
    return { enabled: false, stop() {} };
  }
  // Enrollment is the explicit opt-in. An ordinary installation without an
  // identity never contacts FEMOS; environment override is for controlled tests.
  const base = endpoint(baseUrl || identity.serverUrl);
  if (!base) return { enabled: false, stop() {} };
  if (typeof identity.workerId !== "string" || !/^femos_worker_[A-Za-z0-9_-]{43}$/.test(identity.credential)) {
    throw new Error("Invalid enrolled Worker identity file.");
  }
  let stopped = false;
  let activeController = null;
  const auth = (path, body, timeout) => workerRequest(base, identity.credential, path, body, timeout);
  const heartbeat = () => auth("/api/v1/worker/heartbeat", { version, capability: {
    capabilityKey: CAPABILITY, adapterVersion: ADAPTER_VERSION, supportedTargets: TARGETS, healthy: !isPaused(),
  } });

  async function runClaim(claim) {
    const { executionId, attempt, leaseToken, inputDigest } = claim;
    const plan = safePlan(claim.plan);
    if (!plan || digestPlan(claim.plan) !== inputDigest) {
      await auth(`/api/v1/worker/executions/${executionId}/failure`, { attempt, leaseToken,
        diagnostics: "Claimed compile input failed Worker validation.", retryable: false });
      return;
    }
    const controller = new AbortController();
    activeController = controller;
    let leaseValid = true;
    let lastRenewal = Date.now();
    const renew = async (progress) => {
      try {
        const state = await auth(`/api/v1/worker/executions/${executionId}/renew`, { attempt, leaseToken, progress });
        lastRenewal = Date.now();
        if (state.cancellationRequested) controller.abort(new Error("Compilation cancelled."));
      } catch (error) {
        if (error?.status === 409 || Date.now() - lastRenewal > 35_000) {
          leaseValid = false;
          controller.abort(new Error("Compile lease lost."));
        }
      }
    };
    await renew(0);
    if (!leaseValid) return;
    const timer = setInterval(() => { void renew(40); }, 10_000);
    try {
      const result = await compile(plan, controller.signal);
      if (!leaseValid) return;
      await renew(95);
      if (!leaseValid || controller.signal.aborted) return;
      await auth(`/api/v1/worker/executions/${executionId}/result`, { attempt, leaseToken, result }, 30_000);
      onEvent(`Execution ${executionId} completed.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Compilation failed.";
      if (leaseValid) {
        try {
          await auth(`/api/v1/worker/executions/${executionId}/failure`, { attempt, leaseToken,
            diagnostics: message.slice(-8_000), retryable: false });
        } catch (reportError) {
          onEvent(`Execution ${executionId} could not report failure: ${reportError instanceof Error ? reportError.message : "unknown"}`);
        }
      }
    } finally {
      clearInterval(timer);
      activeController = null;
    }
  }

  const loop = (async () => {
    while (!stopped) {
      try {
        await heartbeat();
        if (!isPaused()) {
          const { claim } = await auth("/api/v1/worker/claim", {});
          if (claim) await runClaim(claim);
        }
      } catch (error) {
        onEvent(`Remote compile connection: ${error instanceof Error ? error.message : "unavailable"}`);
      }
      if (!stopped) await sleep(2_000);
    }
  })();
  return { enabled: true, workerId: identity.workerId, stop() {
    stopped = true;
    activeController?.abort(new Error("Worker stopped."));
  }, done: loop };
}
