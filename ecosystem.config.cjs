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
      },
    },
  ],
};
