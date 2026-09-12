# FEMOS Worker

This repository contains the standalone, loopback-only FEMOS compiler and
hardware-delivery worker. Keep its browser protocol compatible with the FEMOS
web client's `src/features/arduino-blocks/local-uploader.ts` contract.

- Never bind the local API beyond `127.0.0.1`.
- Never persist Wi-Fi or OTA credentials.
- Never enable global contribution based on browser input; it requires the
  service-controlled `FEMOS_SERVICE_COMPILER=true` environment setting.
- Keep compilation and upload bounded, cancellable, and cacheable.
- Board cores are lazy-installed. Do not add them to the base release archive.
- Release archives must include checksums and a self-contained Node.js runtime
  plus Arduino CLI, so users never need the FEMOS web repository.
- Do not commit credentials, generated firmware, board cores, or caches.
