import * as fs from "fs";
import * as path from "path";
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

  const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;
  const imported = await dynamicImport(pathToFileURL(modulePath).href);
  const factory = imported.default ?? imported;
  return factory({
    locateFile: (fileName: string) => path.join(moduleDir, fileName),
    ...options
  });
}
