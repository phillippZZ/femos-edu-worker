# Loopback protocol v2

The worker accepts HTTP only at `127.0.0.1:32145`. Requests with a browser
`Origin` header are accepted only from configured FEMOS origins. Responses are
JSON except upload and monitor streams, which use newline-delimited JSON.

## Endpoints

- `GET /v1/health` — version, capabilities, activity, and settings
- `GET /v1/settings` — local capacity and scope settings
- `POST /v1/settings` — replace validated local settings
- `POST /v1/control` — persist pause/resume, request a supervised restart, or shut down cleanly
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

### Compile source modes

`POST /v1/compile` accepts exactly one source mode:

```json
{ "code": "void setup() {}\nvoid loop() {}" }
```

or a bounded flat source project:

```json
{
  "sourceProject": {
    "entryFile": "main.ino",
    "files": [
      { "path": "main.ino", "content": "..." },
      { "path": "femos_module.h", "content": "..." },
      { "path": "femos_module.cpp", "content": "..." }
    ]
  }
}
```

Source projects are limited to relative, flat `.ino`, `.cpp`, and `.h` files,
with one entry `.ino`, bounded file count/size, and no traversal, hidden,
control, duplicate, or case-colliding paths. The entry content is materialized
as the fixed `FemosSketch.ino`; other files are written beside it in the
temporary sketch directory. `requiredLibraries` retains its existing bounded
library-install contract. Worker health and durable compile heartbeat
advertisements report `sourceModes: ["code", "sourceProject"]`.

## Outbound durable compile protocol v1

After explicit one-time enrollment, the Worker reads its protected identity file
and initiates outbound HTTPS requests to the enrolled FEMOS server. Its bearer
credential is distinct from the owner's login/PAT and is never sent to the
browser, Composition, or CodeFile. The Worker posts heartbeat/capability,
claims at most one eligible `arduino.compile@1` Execution, renews its lease,
then reports either a bounded failure or the actual compiled firmware result.
FEMOS persists the private result Artifact. This path reuses `compileFirmware`
from the loopback adapter; it does not change physical upload/monitor endpoints.

The server endpoints are `POST /api/v1/worker/heartbeat`, `/claim`, `/rotate`,
and `/executions/{id}/renew|result|failure`. A claim includes attempt number,
lease token, validated plan and input digest. The Worker verifies the digest
before invoking Arduino CLI. All result/failure/renew requests carry the
attempt and lease token. FEMOS rejects stale or revoked attempts. A missing
identity file means no remote polling; no inbound Internet port is opened.
