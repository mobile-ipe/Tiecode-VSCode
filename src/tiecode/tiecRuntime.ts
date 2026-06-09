import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ProjectInfo } from "./types";
import { getProjectDefines, resolveMaybeRelative } from "./workspace";
import { loadWasmModule, WasmModuleOptions } from "./wasmModule";

export type TiecodeModuleOptions = WasmModuleOptions;

export interface TiecodeOptionsConfig {
  outputDir: string;
  lineMapPath: string;
  debug: boolean;
  hardMode: boolean;
  ideMode: boolean;
  mapHostPath?: (hostPath: string) => string;
}

export async function loadTiecodeModule(context: vscode.ExtensionContext, options: TiecodeModuleOptions = {}): Promise<any> {
  const tiecDir = path.join(context.extensionPath, "assets", "tiec");
  return loadWasmModule(tiecDir, "tiec.mjs", "结绳", options);
}

export function createTiecodeOptions(tiec: any, project: ProjectInfo, config: TiecodeOptionsConfig): any {
  const options = new tiec.Options();
  options.sourceVersion = enumMember(tiec.SourceVersion, sourceVersionKey(project.sourceVersion), project.sourceVersion);
  options.packageName = project.packageName;
  options.outputDir = config.outputDir;
  options.lineMapPath = config.lineMapPath;
  options.debug = config.debug;
  options.hardMode = config.hardMode;
  options.enableTopLevelStmt = true;
  options.friendlyName = enumMember(tiec.FriendlyNameKind, "RANDOM", 0);
  options.ideMode = config.ideMode;
  options.profile = enumMember(tiec.BuildProfile, "STANDARD", 0);
  options.optimizeLevel = 0;
  options.logLevel = enumMember(tiec.LogLevel, "WARNING", 2);
  options.platform = enumMember(tiec.TargetPlatform, project.platformName.toUpperCase(), project.platformNumber);

  if (typeof options.addSearchPrefix === "function") {
    for (const sourceRoot of project.sourceRoots) {
      options.addSearchPrefix("source", mapPath(sourceRoot, config));
    }
  }

  if (typeof options.define === "function") {
    for (const [name, value] of Object.entries(getProjectDefines(project.config))) {
      options.define(name, value);
    }
  }

  if (project.kind === "android" && typeof options.setAndroidOptions === "function") {
    options.setAndroidOptions(createAndroidOptions(tiec, project, config));
  }

  return options;
}

function createAndroidOptions(tiec: any, project: ProjectInfo, config: TiecodeOptionsConfig): any {
  const android = project.config.android ?? {};
  const appConfig = new tiec.AndroidAppConfig();
  appConfig.appName = android.appName ?? project.config.name ?? "我的应用";
  appConfig.appIcon = resolveAndroidIconPath(project, config, android.iconPath ?? "");
  appConfig.minSdk = android.minSdk ?? 21;
  appConfig.targetSdk = android.targetSdk ?? 28;
  appConfig.versionCode = android.versionCode ?? 1;
  appConfig.versionName = android.versionName ?? "1.0";

  const androidOptions = new tiec.AndroidOptions();
  androidOptions.appConfig = appConfig;
  androidOptions.gradle = true;
  androidOptions.foundationLibPath = project.stdlibSourceRoot
    ? mapPath(path.dirname(project.stdlibSourceRoot), config)
    : "";
  return androidOptions;
}

function resolveAndroidIconPath(project: ProjectInfo, config: TiecodeOptionsConfig, iconPath: string): string {
  if (!iconPath) {
    return "";
  }

  const hostPath = resolveMaybeRelative(project.rootPath, iconPath);
  if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isFile()) {
    return iconPath;
  }
  return mapPath(hostPath, config);
}

function mapPath(hostPath: string, config: TiecodeOptionsConfig): string {
  return config.mapHostPath ? config.mapHostPath(hostPath) : hostPath;
}

function enumMember(enumObject: any, key: string, fallback: number): unknown {
  return enumObject?.[key] ?? fallback;
}

function sourceVersionKey(sourceVersion: number): string {
  if (sourceVersion === 40) {
    return "VERSION_4_0";
  }
  if (sourceVersion === 46) {
    return "VERSION_4_6";
  }
  return "VERSION_4_7";
}
