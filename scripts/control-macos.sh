#!/bin/sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
DATA_DIR="$HOME/Library/Application Support/FEMOS Worker"
PID_FILE="$DATA_DIR/worker.pid"
OUT_LOG="$DATA_DIR/worker.log"
ERROR_LOG="$DATA_DIR/worker-error.log"
ACTION="${1:-status}"

healthy() { curl -fsS http://127.0.0.1:32145/v1/health >/dev/null 2>&1; }

start_worker() {
  if healthy; then echo "FEMOS Worker is already running."; return; fi
  mkdir -p "$DATA_DIR"
  nohup "$APP_DIR/bin/femos-worker" >>"$OUT_LOG" 2>>"$ERROR_LOG" </dev/null &
  echo "$!" > "$PID_FILE"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if healthy; then echo "FEMOS Worker started."; return; fi
    sleep 1
  done
  echo "FEMOS Worker did not become healthy. Check $ERROR_LOG" >&2
  exit 1
}

stop_worker() {
  if healthy; then
    curl -fsS -X POST -H 'Content-Type: application/json' --data '{"action":"shutdown"}' http://127.0.0.1:32145/v1/control >/dev/null || true
    for attempt in 1 2 3 4 5; do
      if ! healthy; then rm -f "$PID_FILE"; echo "FEMOS Worker stopped."; return; fi
      sleep 1
    done
  fi
  if [ -f "$PID_FILE" ]; then
    WORKER_PID="$(cat "$PID_FILE")"
    case "$WORKER_PID" in (*[!0-9]*|'') ;; (*) kill "$WORKER_PID" >/dev/null 2>&1 || true ;; esac
    rm -f "$PID_FILE"
  fi
  echo "FEMOS Worker is stopped."
}

case "$ACTION" in
  start) start_worker ;;
  stop) stop_worker ;;
  restart) stop_worker; start_worker ;;
  status)
    if curl -fsS http://127.0.0.1:32145/v1/health; then printf '\n'; else echo "FEMOS Worker is stopped."; fi
    ;;
  *) echo "usage: femos-worker-control {start|stop|restart|status}" >&2; exit 2 ;;
esac
