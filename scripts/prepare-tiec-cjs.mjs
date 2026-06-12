import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tiecRoot = path.join(root, "assets", "tiec");
const sourcePath = path.join(tiecRoot, "tiec.mjs");
const targetPath = path.join(tiecRoot, "tiec.cjs");

let source = fs.readFileSync(sourcePath, "utf8");

source = source.replace(
  'const{createRequire}=await import("module");var require=createRequire(import.meta.url)',
  'var require=module.require.bind(module)'
);
source = source.replace(/import\.meta\.url/g, "__filename");
source = source.replace(/export default createTiec;?\s*$/u, "module.exports = createTiec;\n");

fs.writeFileSync(targetPath, source, "utf8");
