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

export function buildEspOtaUploadArgs({ fqbn, inputDir, host, password, sketchDir }) {
  return [
    "upload",
    "--port", host,
    "--protocol", "network",
    "--fqbn", fqbn,
    "--input-dir", inputDir,
    "--upload-field", `password=${password}`,
    sketchDir,
  ];
}
