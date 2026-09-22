module.exports = {
  apps: [
    {
      name: "femos-uploader",
      cwd: __dirname,
      script: "src/server.mjs",
      interpreter: "/opt/homebrew/bin/node",
      autorestart: true,
      stop_exit_codes: [0],
      env: {
        NODE_ENV: "production",
        ARDUINO_CLI_PATH: "/opt/homebrew/bin/arduino-cli",
        FEMOS_SERVICE_COMPILER: "true",
        FEMOS_FIRMWARE_CACHE_DIR: "/Volumes/KESU/FEMOS/firmware-cache",
        FEMOS_WORKER_SETTINGS_PATH: "/Volumes/KESU/FEMOS/worker-settings.json",
        // Reviewed digital slicing profile; print dispatch remains simulated only.
        FEMOS_PRUSASLICER_PATH: "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer",
        FEMOS_PRUSASLICER_PROFILE_PATH: require("node:path").join(__dirname, "profiles/generic-pla-0.4.ini"),
        FEMOS_SIMULATED_PRINTER: "true",
      },
    },
  ],
};
