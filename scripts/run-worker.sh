#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
export ARDUINO_CLI_PATH="$ROOT/bin/arduino-cli"
exec "$ROOT/bin/node" "$ROOT/app/src/server.mjs"
