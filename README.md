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
`~/Library/Application Support/FEMOS Worker`, registers a per-user LaunchAgent,
starts the worker, and checks its health. Re-run the same command to update.

## Install on Windows

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/phillippZZ/femos-edu-worker/main/installers/install-windows.ps1 -OutFile install-femos-worker.ps1
powershell -ExecutionPolicy Bypass -File .\install-femos-worker.ps1
```

The Windows installer uses `%LOCALAPPDATA%\FEMOS Worker`, registers a per-user
scheduled task, starts the worker, and verifies its health.

After installation, open [Worker Console](https://femos.ai/worker-console) to
choose **This computer** or **FEMOS workers**, configure capacity, initialize
ESP32 Wi-Fi, or host a classroom upload bridge.

Worker Console can pause/resume work and request a supervised restart. A fully
stopped worker cannot receive browser commands, so use the installed control
script for true process lifecycle operations:

```sh
"$HOME/Library/Application Support/FEMOS Worker/app/bin/femos-worker-control" status
"$HOME/Library/Application Support/FEMOS Worker/app/bin/femos-worker-control" stop
"$HOME/Library/Application Support/FEMOS Worker/app/bin/femos-worker-control" start
"$HOME/Library/Application Support/FEMOS Worker/app/bin/femos-worker-control" restart
```

On Windows, download `installers/control-windows.ps1` and run it with
`-Action start`, `stop`, `restart`, or `status`.

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
