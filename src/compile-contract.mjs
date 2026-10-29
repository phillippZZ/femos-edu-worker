export const MAX_CODE_BYTES = 100_000;
export const MAX_SOURCE_PROJECT_FILES = 256;
export const MAX_SOURCE_PROJECT_FILE_BYTES = 512 * 1024;
export const MAX_SOURCE_PROJECT_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_PROJECT_PATH_LENGTH = 160;
export const SOURCE_PROJECT_MODES = ["code", "sourceProject"];

export function hasCompleteEsp32ArtifactFiles(files) {
  if (!Array.isArray(files)) return false;
  const names = files.map((file) => typeof file === "string" ? file : file?.name);
  return names.includes("flash_args")
    && names.includes("boot_app0.bin")
    && names.some((name) => typeof name === "string" && name.endsWith(".ino.bin"))
    && names.some((name) => typeof name === "string" && name.endsWith(".ino.bootloader.bin"))
    && names.some((name) => typeof name === "string" && name.endsWith(".ino.partitions.bin"));
}

function normalizeSourcePath(value) {
  if (typeof value !== "string" || !value || value.length > MAX_SOURCE_PROJECT_PATH_LENGTH || value.includes("\\") || value.includes("\0")) return null;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const segments = value.split("/");
  if (segments.length !== 1 || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || /[\u0000-\u001f\u007f]/.test(segment))) return null;
  const fileName = segments.at(-1) || "";
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (extension !== ".ino" && extension !== ".cpp" && extension !== ".h") return null;
  return segments.join("/");
}

export function parseSourceProject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entryFile = normalizeSourcePath(value.entryFile);
  if (!entryFile || !entryFile.toLowerCase().endsWith(".ino")) return null;
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_SOURCE_PROJECT_FILES) return null;
  const seen = new Set();
  let totalBytes = 0;
  const files = [];
  for (const item of value.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const path = normalizeSourcePath(item.path);
    if (!path || seen.has(path.toLowerCase()) || typeof item.content !== "string" || item.content.includes("\0")) return null;
    const bytes = Buffer.byteLength(item.content, "utf8");
    if (bytes < 1 || bytes > MAX_SOURCE_PROJECT_FILE_BYTES) return null;
    totalBytes += bytes;
    if (totalBytes > MAX_SOURCE_PROJECT_TOTAL_BYTES) return null;
    seen.add(path.toLowerCase());
    files.push({ path, content: item.content });
  }
  if (files.filter((file) => file.path.toLowerCase().endsWith(".ino")).length !== 1 || !files.some((file) => file.path === entryFile)) return null;
  return { entryFile, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

export function materializedSourceProjectFiles(sourceProject) {
  return sourceProject.files.map((file) => ({
    path: file.path === sourceProject.entryFile ? "FemosSketch.ino" : file.path,
    content: file.content,
  }));
}

export function parseRequiredLibraries(value) {
  if (!Array.isArray(value) || value.length > 32) return null;
  const libraries = [];
  for (const item of value) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const version = item?.version == null ? null : typeof item.version === "string" ? item.version.trim() : "";
    if (!name || name.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9 ._+()/-]*$/.test(name)) return null;
    if (version !== null && (!version || version.length > 40 || !/^[A-Za-z0-9._+-]+$/.test(version))) return null;
    libraries.push({ name, version });
  }
  return libraries;
}

export function parseSourceMode(body) {
  const hasCode = typeof body?.code === "string";
  const hasSourceProject = body?.sourceProject !== undefined;
  if (hasCode === hasSourceProject) return null;
  if (hasCode && (body.code.length < 1 || body.code.length > MAX_CODE_BYTES)) return null;
  const sourceProject = hasSourceProject ? parseSourceProject(body.sourceProject) : null;
  if (hasSourceProject && !sourceProject) return null;
  return hasCode ? { mode: "code", code: body.code } : { mode: "sourceProject", sourceProject };
}
