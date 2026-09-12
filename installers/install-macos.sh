#!/bin/sh
set -eu

REPOSITORY="phillippZZ/femos-edu-worker"
INSTALL_ROOT="$HOME/Library/Application Support/FEMOS Worker"
APP_DIR="$INSTALL_ROOT/app"
DATA_DIR="$INSTALL_ROOT/data"
PLIST="$HOME/Library/LaunchAgents/ai.femos.worker.plist"
LABEL="ai.femos.worker"

case "$(uname -m)" in
  arm64) ASSET="femos-worker-macos-arm64.tar.gz" ;;
  x86_64) ASSET="femos-worker-macos-x64.tar.gz" ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/femos-worker-install.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

BASE_URL="https://github.com/$REPOSITORY/releases/latest/download"
echo "Downloading FEMOS Worker…"
curl -fL --retry 3 "$BASE_URL/$ASSET" -o "$WORK_DIR/$ASSET"
curl -fL --retry 3 "$BASE_URL/$ASSET.sha256" -o "$WORK_DIR/$ASSET.sha256"
(cd "$WORK_DIR" && shasum -a 256 -c "$ASSET.sha256")

tar -xzf "$WORK_DIR/$ASSET" -C "$WORK_DIR"
test -x "$WORK_DIR/femos-worker/bin/node"
test -x "$WORK_DIR/femos-worker/bin/arduino-cli"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
mkdir -p "$INSTALL_ROOT" "$DATA_DIR" "$HOME/Library/LaunchAgents"
if [ -d "$APP_DIR" ]; then
  rm -rf "$INSTALL_ROOT/app.previous"
  mv "$APP_DIR" "$INSTALL_ROOT/app.previous"
fi
mv "$WORK_DIR/femos-worker" "$APP_DIR"
EXPECTED_VERSION="$(cat "$APP_DIR/VERSION")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP_DIR/bin/femos-worker</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR/worker.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/worker-error.log</string>
</dict></plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  HEALTH="$(curl -fsS http://127.0.0.1:32145/v1/health 2>/dev/null || true)"
  if printf '%s' "$HEALTH" | grep -q "\"version\":\"$EXPECTED_VERSION\""; then
    echo "FEMOS Worker is installed and running."
    echo "Open https://femos.ai/worker-console"
    exit 0
  fi
  sleep 1
done

echo "The worker was installed but did not become healthy." >&2
echo "If another worker already uses port 32145, stop it and run this installer again." >&2
echo "Check: $DATA_DIR/worker-error.log" >&2
exit 1
