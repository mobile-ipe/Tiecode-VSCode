import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stdlibsRoot = path.join(root, "assets", "stdlibs");
const packagesRoot = path.join(root, "assets", "stdlib-packages");

const packages = [
  ["android", "安卓基本库"],
  ["cxx", "CXX基本库"],
  ["html", "网页基本库"]
];

fs.rmSync(packagesRoot, { recursive: true, force: true });
fs.mkdirSync(packagesRoot, { recursive: true });

for (const [id, folderName] of packages) {
  const sourceRoot = path.join(stdlibsRoot, folderName);
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`Missing stdlib folder: ${sourceRoot}`);
  }

  const zip = new AdmZip();
  zip.addLocalFolder(sourceRoot, folderName);
  zip.writeZip(path.join(packagesRoot, `${id}.zip`));
}
