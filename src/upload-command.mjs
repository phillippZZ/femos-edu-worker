export function buildUsbUploadArgs({ fqbn, inputDir, inputFile, port, sketchDir }) {
  return [
    "upload",
    "--port",
    port,
    "--fqbn",
    fqbn,
    ...(inputFile ? ["--input-file", inputFile] : ["--input-dir", inputDir]),
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
    "--progress",
    "-f",
    firmwarePath,
  ];
}
