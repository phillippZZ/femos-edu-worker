# Third-party software

FEMOS Worker release archives redistribute the official Node.js runtime and
Arduino CLI binaries without modification.

- Node.js: https://github.com/nodejs/node — license text is included as
  `licenses/node-LICENSE` in every release archive.
- Arduino CLI: https://github.com/arduino/arduino-cli — GPL-3.0 source for the
  packaged version is available from the matching upstream Git tag, recorded in
  `licenses/arduino-cli-SOURCE`; its license is included as
  `licenses/arduino-cli-LICENSE.txt`.

Arduino board cores and libraries are not bundled. Arduino CLI downloads them
from their official package indexes when a user first selects the corresponding
target or library. Their own license terms apply.
