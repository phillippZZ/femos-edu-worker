#!/bin/sh
set -eu

LABEL="ai.femos.worker"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ACTION="${1:-status}"

case "$ACTION" in
  start)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl kickstart "$DOMAIN/$LABEL"
    else
      launchctl bootstrap "$DOMAIN" "$PLIST"
    fi
    ;;
  stop)
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    ;;
  restart)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl kickstart -k "$DOMAIN/$LABEL"
    else
      launchctl bootstrap "$DOMAIN" "$PLIST"
    fi
    ;;
  status)
    if curl -fsS http://127.0.0.1:32145/v1/health; then printf '\n'; else echo "FEMOS Worker is stopped."; fi
    ;;
  *) echo "usage: femos-worker-control {start|stop|restart|status}" >&2; exit 2 ;;
esac
