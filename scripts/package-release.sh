#!/bin/sh
set -eu

TARGET="${1:?usage: package-release.sh <macos-arm64|macos-x64|linux-x64|windows-x64>}"
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/femos-worker-package.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

case "$TARGET" in
  macos-arm64)
    NODE_PATTERN='node-v[0-9.]*-darwin-arm64.tar.gz$'
    ARDUINO_SUFFIX='macOS_ARM64.tar.gz'
    ARCHIVE="femos-worker-macos-arm64.tar.gz"
    ;;
  macos-x64)
    NODE_PATTERN='node-v[0-9.]*-darwin-x64.tar.gz$'
    ARDUINO_SUFFIX='macOS_64bit.tar.gz'
    ARCHIVE="femos-worker-macos-x64.tar.gz"
    ;;
  linux-x64)
    NODE_PATTERN='node-v[0-9.]*-linux-x64.tar.gz$'
    ARDUINO_SUFFIX='Linux_64bit.tar.gz'
    ARCHIVE="femos-worker-linux-x64.tar.gz"
    ;;
  windows-x64)
    NODE_PATTERN='node-v[0-9.]*-win-x64.zip$'
    ARDUINO_SUFFIX='Windows_64bit.zip'
    ARCHIVE="femos-worker-windows-x64.zip"
    ;;
  *) echo "Unsupported target: $TARGET" >&2; exit 1 ;;
esac

mkdir -p "$DIST" "$WORK/femos-worker/bin" "$WORK/femos-worker/app" "$WORK/femos-worker/licenses"
cp -R "$ROOT/src" "$WORK/femos-worker/app/src"
cp "$ROOT/package.json" "$WORK/femos-worker/app/package.json"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$WORK/femos-worker/THIRD_PARTY_NOTICES.md"
node -p 'require(process.argv[1]).version' "$ROOT/package.json" > "$WORK/femos-worker/VERSION"

NODE_SUMS="$WORK/node-shasums.txt"
curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$NODE_SUMS"
NODE_FILE="$(awk -v pattern="$NODE_PATTERN" '$2 ~ pattern { print $2; exit }' "$NODE_SUMS")"
test -n "$NODE_FILE"
curl -fsSL "https://nodejs.org/dist/latest-v22.x/$NODE_FILE" -o "$WORK/$NODE_FILE"
(cd "$WORK" && grep " $NODE_FILE\$" node-shasums.txt | sha256sum -c -)

ARDUINO_RELEASE_JSON="$WORK/arduino-release.json"
curl -fsSL https://api.github.com/repos/arduino/arduino-cli/releases/latest -o "$ARDUINO_RELEASE_JSON"
ARDUINO_TAG="$(node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(r.tag_name)' "$ARDUINO_RELEASE_JSON")"
ARDUINO_VERSION="${ARDUINO_TAG#v}"
ARDUINO_FILE="arduino-cli_${ARDUINO_VERSION}_${ARDUINO_SUFFIX}"
ARDUINO_BASE="https://github.com/arduino/arduino-cli/releases/download/$ARDUINO_TAG"
curl -fsSL "$ARDUINO_BASE/$ARDUINO_FILE" -o "$WORK/$ARDUINO_FILE"
curl -fsSL "$ARDUINO_BASE/${ARDUINO_VERSION}-checksums.txt" -o "$WORK/arduino-checksums.txt"
curl -fsSL "https://raw.githubusercontent.com/arduino/arduino-cli/$ARDUINO_TAG/LICENSE.txt" -o "$WORK/femos-worker/licenses/arduino-cli-LICENSE.txt"
printf '%s\n' "https://github.com/arduino/arduino-cli/tree/$ARDUINO_TAG" > "$WORK/femos-worker/licenses/arduino-cli-SOURCE"
(cd "$WORK" && grep " $ARDUINO_FILE\$" arduino-checksums.txt | sha256sum -c -)

if [ "$TARGET" = "windows-x64" ]; then
  unzip -q "$WORK/$NODE_FILE" -d "$WORK/node"
  unzip -q "$WORK/$ARDUINO_FILE" -d "$WORK/arduino"
  cp "$WORK/node"/*/node.exe "$WORK/femos-worker/bin/node.exe"
  cp "$WORK/node"/*/LICENSE "$WORK/femos-worker/licenses/node-LICENSE"
  cp "$WORK/arduino/arduino-cli.exe" "$WORK/femos-worker/bin/arduino-cli.exe"
  (cd "$WORK" && zip -qr "$DIST/$ARCHIVE" femos-worker)
else
  mkdir -p "$WORK/node" "$WORK/arduino"
  tar -xzf "$WORK/$NODE_FILE" -C "$WORK/node"
  tar -xzf "$WORK/$ARDUINO_FILE" -C "$WORK/arduino"
  cp "$WORK/node"/*/bin/node "$WORK/femos-worker/bin/node"
  cp "$WORK/node"/*/LICENSE "$WORK/femos-worker/licenses/node-LICENSE"
  cp "$WORK/arduino/arduino-cli" "$WORK/femos-worker/bin/arduino-cli"
  cp "$ROOT/scripts/run-worker.sh" "$WORK/femos-worker/bin/femos-worker"
  if [ "$TARGET" = "macos-arm64" ] || [ "$TARGET" = "macos-x64" ]; then
    cp "$ROOT/scripts/control-macos.sh" "$WORK/femos-worker/bin/femos-worker-control"
  fi
  chmod 755 "$WORK/femos-worker/bin/node" "$WORK/femos-worker/bin/arduino-cli" "$WORK/femos-worker/bin/femos-worker"
  if [ -f "$WORK/femos-worker/bin/femos-worker-control" ]; then chmod 755 "$WORK/femos-worker/bin/femos-worker-control"; fi
  tar -czf "$DIST/$ARCHIVE" -C "$WORK" femos-worker
fi

(cd "$DIST" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256")
echo "$DIST/$ARCHIVE"
