export function buildUsbUploadArgs({ fqbn, inputDir, port, sketchDir }) {
  return [
    "upload",
    "--port",
    port,
    "--fqbn",
    fqbn,
    "--input-dir",
    inputDir,
    sketchDir,
  ];
}

export function buildEspOtaArgs({ scriptPath, host, password, firmwarePath }) {
  return [
    ...(scriptPath ? [scriptPath] : []),
    "-r",
    "-i",
    host,
    "-p",
    "3232",
    `--auth=${password}`,
    "-f",
    firmwarePath,
  ];
}
