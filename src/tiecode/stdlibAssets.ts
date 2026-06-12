import AdmZip from "adm-zip";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getExtensionRoot, setBundledStdlibsPath } from "./workspace";

const STDLIB_PACKAGE_NAMES = ["android.zip", "cxx.zip", "html.zip"];

export function initializeBundledStdlibs(context: vscode.ExtensionContext): void {
  const packagesRoot = path.join(getExtensionRoot(), "assets", "stdlib-packages");
  if (!fs.existsSync(packagesRoot)) {
    setBundledStdlibsPath(path.join(getExtensionRoot(), "assets", "stdlibs"));
    return;
  }

  const marker = createPackageMarker(packagesRoot);
  const extractRoot = path.join(context.globalStorageUri.fsPath, "stdlibs");
  const markerPath = path.join(extractRoot, ".stdlib-packages.json");

  if (readMarker(markerPath) !== marker) {
    fs.rmSync(extractRoot, { recursive: true, force: true });
    fs.mkdirSync(extractRoot, { recursive: true });
    for (const packageName of STDLIB_PACKAGE_NAMES) {
      new AdmZip(path.join(packagesRoot, packageName)).extractAllTo(extractRoot, true);
    }
    fs.writeFileSync(markerPath, marker, "utf8");
  }

  setBundledStdlibsPath(extractRoot);
}

function createPackageMarker(packagesRoot: string): string {
  const packages = STDLIB_PACKAGE_NAMES.map(name => {
    const packagePath = path.join(packagesRoot, name);
    const stats = fs.statSync(packagePath);
    return {
      name,
      size: stats.size,
      mtimeMs: Math.trunc(stats.mtimeMs)
    };
  });
  return `${JSON.stringify({ packages }, null, 2)}\n`;
}

function readMarker(markerPath: string): string | undefined {
  try {
    return fs.readFileSync(markerPath, "utf8");
  } catch {
    return undefined;
  }
}
