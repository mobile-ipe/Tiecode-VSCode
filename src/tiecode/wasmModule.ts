import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";

type DynamicImport = (specifier: string) => Promise<any>;

export interface WasmModuleOptions {
  print?: (message: string) => void;
  printErr?: (message: string) => void;
}

export async function loadWasmModule(
  moduleDir: string,
  moduleFileName: string,
  displayName: string,
  options: WasmModuleOptions = {}
): Promise<any> {
  const modulePath = path.join(moduleDir, moduleFileName);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`找不到${displayName} WASM 模块: ${modulePath}`);
  }

  const commonJsPath = modulePath.replace(/\.mjs$/i, ".cjs");
  const imported = fs.existsSync(commonJsPath)
    ? createRequire(__filename)(commonJsPath)
    : await importEsmModule(modulePath);
  const factory = imported.default ?? imported;
  return factory({
    locateFile: (fileName: string) => path.join(moduleDir, fileName),
    ...options
  });
}

async function importEsmModule(modulePath: string): Promise<any> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;
  return dynamicImport(pathToFileURL(modulePath).href);
}
