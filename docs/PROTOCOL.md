# Loopback protocol v2

The worker accepts HTTP only at `127.0.0.1:32145`. Requests with a browser
`Origin` header are accepted only from configured FEMOS origins. Responses are
JSON except upload and monitor streams, which use newline-delimited JSON.

## Endpoints

- `GET /v1/health` — version, capabilities, activity, and settings
- `GET /v1/settings` — local capacity and scope settings
- `POST /v1/settings` — replace validated local settings
- `POST /v1/control` — persist pause/resume or request a supervised restart
- `POST /v1/compile` — compile a validated FEMOS build plan
- `GET /v1/boards` — discover connected supported boards
- `POST /v1/upload` — USB or ESP32 OTA firmware delivery
- `POST /v1/provision` — USB flash plus private ESP32 Wi-Fi configuration
- `POST /v1/monitor/start` — open a serial-monitor stream
- `POST /v1/monitor/write` — send serial input
- `POST /v1/monitor/stop` — close the active serial monitor

The authoritative browser client is maintained in FEMOS at
`src/features/arduino-blocks/local-uploader.ts`. Protocol changes must remain
backward-compatible within the current major version or coordinate a client
release before the worker release.
