# FEMOS Worker

FEMOS Worker is the small local companion for [FEMOS](https://femos.ai). It
compiles Arduino-family projects and delivers firmware to boards reachable from
the computer. Its API listens only on `127.0.0.1:32145`.

Teachers and students do **not** need the FEMOS application repository, Node.js,
Arduino CLI, or preinstalled board packages. Official release archives contain
the runtime and Arduino CLI. Board cores and libraries are installed lazily the
first time they are needed.

## Install on macOS

```sh
curl -fsSLO https://raw.githubusercontent.com/phillippZZ/femos-edu-worker/main/installers/install-macos.sh
sh install-macos.sh
```

The installer verifies the release checksum, installs under
`~/Library/Application Support/FEMOS Worker`, removes older automatic-start
registrations, starts the worker once, and checks its health. It does not run at
computer login. Re-run the same command to update.

## Install on Windows

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/phillippZZ/femos-edu-worker/main/installers/install-windows.ps1 -OutFile install-femos-worker.ps1
powershell -ExecutionPolicy Bypass -File .\install-femos-worker.ps1
```

The Windows installer uses `%LOCALAPPDATA%\FEMOS Worker`, removes older
automatic-start tasks, starts the worker once, and verifies its health. It does
not run at computer login.

After installation, open [Worker Console](https://femos.ai/worker-console) to
choose **This computer** or **FEMOS workers**, configure capacity, initialize
ESP32 Wi-Fi, or host a classroom upload bridge.

### Enroll for durable FEMOS operations

In Worker Console, an authenticated owner can create a named, one-time Worker
enrollment token. On the intended computer, pass that token on standard input
to the bundled `app/enroll-worker.mjs` script with `https://femos.ai` as its
argument. Use the bundled Node runtime (`bin/node` or `bin/node.exe`). Do not
put the token in a command argument or shell history. Restart the Worker after
enrollment. Enrollment stores a protected, per-computer identity file containing
its independent credential and the explicitly selected FEMOS server URL.
Without enrollment, the ordinary local upload/compile service does not make
outbound Execution polling requests. The owner can revoke that Worker from
Worker Console; a revoked credential cannot claim or report another build.
The bundled `app/rotate-worker.mjs` script rotates the credential without
showing it, then the Worker must be restarted within the 10-minute overlap.

Enrollment advertises reviewed `arduino.compile@1` and `arduino.upload@1`
capabilities. Managed upload is owner-requested through FEMOS and is limited to
an explicitly enrolled Device with a verified USB VID/PID/serial fingerprint,
a fresh Worker attachment, and an exact compiled Firmware Artifact. The Worker
rediscovers the board before using its transient local port. A failed or lost
physical upload is never retried automatically; FEMOS requires inspection and
explicit reconciliation. Boards without a stable USB identity still use the
existing local/browser upload path. ESP32 OTA and Serial Monitor remain local
operations. The Worker never accepts a remote shell command or a
caller-supplied executable or firmware path.

Worker Console can pause/resume work, restart the process, or fully
shut down the service. A stopped worker cannot receive browser commands, so use
the installed control script to start it again or for terminal lifecycle operations:

```sh
"$HOME/Library/Application Support/FEMOS Worker/app/bin/femos-worker-control" status
"$HOME/Library/Application Support/FEMOS Worker/app/bin/femos-worker-control" stop
"$HOME/Library/Application Support/FEMOS Worker/app/bin/femos-worker-control" start
"$HOME/Library/Application Support/FEMOS Worker/app/bin/femos-worker-control" restart
```

On Windows, run the installed
`%LOCALAPPDATA%\FEMOS Worker\app\bin\femos-worker-control.ps1` with `-Action
start`, `stop`, `restart`, or `status`.

## Development

Requirements: Node.js 20+ and Arduino CLI on `PATH`.

```sh
npm test
npm run check
npm start
```

The FEMOS production Mac may run this checkout with PM2:

```sh
pm2 start ecosystem.config.cjs
pm2 save
```

That service profile preserves the existing KESU cache/settings paths and is
the only profile allowed to advertise `public-world` compilation.

Successful firmware is cached for seven days. Settings and caches live in the
operating system's per-user application-data directory unless overridden with
`FEMOS_WORKER_DATA_DIR`, `FEMOS_FIRMWARE_CACHE_DIR`, or
`FEMOS_WORKER_SETTINGS_PATH`.

## Security boundaries

- The worker listens on loopback only.
- Only exact FEMOS and local-development origins are accepted.
- Wi-Fi and OTA credentials travel from the browser to the local worker and
  then over the attached ESP32's serial connection; they are not persisted.
- Public-world compilation is disabled in ordinary installations.
- Firmware, request sizes, concurrency, and execution time are bounded.
