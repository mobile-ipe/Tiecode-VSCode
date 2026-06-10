import * as path from "path";
import * as vscode from "vscode";

export interface WasmPathMount {
  mountPoint: string;
  hostRoot: string;
}

export function resolveWasmOrHostPath(filePath: string, fallbackRoot: string, mounts: WasmPathMount[]): string {
  const rawPath = filePath.trim();
  for (const mount of mounts) {
    const relativePath = readWasmMountRelativePath(rawPath, mount.mountPoint);
    if (relativePath !== undefined) {
      return path.normalize(path.join(mount.hostRoot, relativePath));
    }
  }

  if (/^file:\/\//i.test(rawPath)) {
    try {
      return path.normalize(vscode.Uri.parse(rawPath).fsPath);
    } catch {
      return path.normalize(rawPath);
    }
  }

  if (path.isAbsolute(rawPath)) {
    return path.normalize(rawPath);
  }

  return path.normalize(path.join(fallbackRoot, rawPath));
}

function readWasmMountRelativePath(filePath: string, mountPoint: string): string | undefined {
  const normalized = normalizeSlashes(filePath);
  if (normalized === mountPoint) {
    return "";
  }
  if (normalized.startsWith(`${mountPoint}/`)) {
    return normalized.slice(mountPoint.length + 1);
  }
  return undefined;
}

export function mapHostPathToWasmMounts(filePath: string, mounts: WasmPathMount[]): string | undefined {
  for (const mount of mounts) {
    const wasmPath = mapHostPathToWasmMount(filePath, mount);
    if (wasmPath) {
      return wasmPath;
    }
  }
  return undefined;
}

export function mapHostPathToWasmMount(filePath: string, mount: WasmPathMount): string | undefined {
  const resolved = path.resolve(filePath);
  const root = path.resolve(mount.hostRoot);
  if (!isInsideOrSame(resolved, root)) {
    return undefined;
  }
  return joinWasmPath(mount.mountPoint, path.relative(root, resolved));
}

function isInsideOrSame(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function joinWasmPath(root: string, relativePath: string): string {
  if (!relativePath) {
    return root;
  }
  return `${root}/${normalizeSlashes(relativePath)}`;
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}
