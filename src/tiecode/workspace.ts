import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  BUILD_DIR_NAME,
  CompilerPaths,
  LIB_DIR_NAME,
  PlatformName,
  PROJECT_CONFIG_FILE,
  ProjectInfo,
  ProjectKind,
  SOURCE_DIR_NAME,
  TARGET_PLATFORM_NUMBER,
  TiecodeProjectConfig
} from "./types";

const DEFAULT_COMPILER_ROOT = "D:\\Projects\\CrossPlatform\\Tiecode-Compiler";

export function getWorkspaceRoot(uri?: vscode.Uri): string | undefined {
  if (uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function getProjectInfo(uri?: vscode.Uri, overrideKind?: ProjectKind): ProjectInfo | undefined {
  const rootPath = getWorkspaceRoot(uri);
  if (!rootPath) {
    return undefined;
  }

  const configPath = path.join(rootPath, PROJECT_CONFIG_FILE);
  const config = readProjectConfig(configPath);
  const kind = overrideKind ?? detectProjectKind(rootPath, config);
  const platformName = detectPlatformName(kind, config);
  const sourceVersion = normalizeSourceVersion(config.sourceVersion);
  const compiler = resolveCompilerPaths(rootPath, config);
  const outputDir = resolveOutputDirectory(rootPath);
  const lineMapPath = path.join(outputDir, "mapping.bin");
  const projectSourceRoots = collectProjectSourceRoots(rootPath);
  const stdlibSourceRoot = resolveStdlibSourceRoot(compiler.stdlibsPath, kind);
  const sourceRoots = dedupe([...projectSourceRoots, ...(stdlibSourceRoot ? [stdlibSourceRoot] : [])]);
  const sourceFiles = scanTiecodeFiles(sourceRoots);

  return {
    rootPath,
    configPath,
    config,
    kind,
    platformName,
    platformNumber: TARGET_PLATFORM_NUMBER[platformName],
    packageName: config.packageName ?? config.android?.packageName ?? config.android?.package ?? "cn.tiecode.app",
    sourceVersion,
    outputDir,
    lineMapPath,
    sourceRoots,
    projectSourceRoots,
    stdlibSourceRoot,
    sourceFiles,
    compiler
  };
}

export function readProjectConfig(configPath: string): TiecodeProjectConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as TiecodeProjectConfig;
  } catch (error) {
    void vscode.window.showWarningMessage(`结绳工程配置读取失败: ${String(error)}`);
    return {};
  }
}

export function writeProjectConfig(rootPath: string, config: TiecodeProjectConfig): void {
  fs.writeFileSync(path.join(rootPath, PROJECT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeTextFile(filePath: string, content: string): void {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

export function resolveCompilerPaths(rootPath: string, config: TiecodeProjectConfig): CompilerPaths {
  const settings = vscode.workspace.getConfiguration("tiecode");
  const compilerRoot = resolveMaybeRelative(
    rootPath,
    config.compiler?.root ?? settings.get<string>("compiler.root") ?? DEFAULT_COMPILER_ROOT
  );
  const configuredTiec = config.compiler?.tiecPath ?? settings.get<string | null>("compiler.tiecPath");
  const configuredStdlibs = config.compiler?.stdlibsPath ?? settings.get<string | null>("compiler.stdlibsPath");

  return {
    rootPath: compilerRoot,
    tiecPath: configuredTiec ? resolveMaybeRelative(rootPath, configuredTiec) : defaultTiecPath(compilerRoot),
    stdlibsPath: configuredStdlibs ? resolveMaybeRelative(rootPath, configuredStdlibs) : path.join(compilerRoot, "stdlibs")
  };
}

export function resolveStdlibSourceRoot(stdlibsPath: string, kind: ProjectKind): string | undefined {
  const folderName = kind === "android" ? "安卓基本库" : kind === "html" ? "网页基本库" : "CXX基本库";
  const sourceRoot = path.join(stdlibsPath, folderName, SOURCE_DIR_NAME);
  return fs.existsSync(sourceRoot) ? sourceRoot : undefined;
}

export function collectProjectSourceRoots(rootPath: string): string[] {
  const roots: string[] = [];
  const sourceRoot = path.join(rootPath, SOURCE_DIR_NAME);
  if (fs.existsSync(sourceRoot)) {
    roots.push(sourceRoot);
  }

  const libRoot = path.join(rootPath, LIB_DIR_NAME);
  if (fs.existsSync(libRoot)) {
    for (const entry of fs.readdirSync(libRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageRoot = path.join(libRoot, entry.name);
      const packageSourceRoot = path.join(packageRoot, SOURCE_DIR_NAME);
      roots.push(fs.existsSync(packageSourceRoot) ? packageSourceRoot : packageRoot);
    }
  }

  return dedupe(roots);
}

export function scanTiecodeFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    if (fs.existsSync(root)) {
      scanDirectory(root, files);
    }
  }
  return dedupe(files).sort((left, right) => left.localeCompare(right));
}

export function isTiecodeDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "tiecode" || document.fileName.toLocaleLowerCase().endsWith(".t");
}

export function isInsideRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function normalizeProjectKind(value: unknown): ProjectKind | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLocaleLowerCase();
  if (normalized === "android" || normalized === "安卓" || normalized === "cn.tiecode.android") {
    return "android";
  }
  if (normalized === "html" || normalized === "web" || normalized === "webpage" || normalized === "网页" || normalized === "cn.tiecode.html") {
    return "html";
  }
  if (normalized === "cxx" || normalized === "cpp" || normalized === "linux" || normalized === "windows" || normalized === "cn.tiecode.linux") {
    return "cxx";
  }
  return undefined;
}

export function normalizePlatformName(value: unknown): PlatformName | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLocaleLowerCase();
  if (normalized === "android") {
    return "android";
  }
  if (normalized === "html" || normalized === "web" || normalized === "webpage") {
    return "html";
  }
  if (normalized === "linux") {
    return "linux";
  }
  if (normalized === "windows" || normalized === "win32") {
    return "windows";
  }
  return undefined;
}

export function normalizeSourceVersion(value: unknown): number {
  const settings = vscode.workspace.getConfiguration("tiecode");
  const configured = Number(value ?? settings.get<number>("sourceVersion") ?? 47);
  return configured === 40 || configured === 46 || configured === 47 ? configured : 47;
}

export function resolveMaybeRelative(rootPath: string, value: string): string {
  const expanded = expandWorkspaceVariables(rootPath, value);
  return path.isAbsolute(expanded) ? expanded : path.join(rootPath, expanded);
}

export function expandWorkspaceVariables(rootPath: string, value: string): string {
  return value.replace(/\$\{workspaceFolder\}/g, rootPath);
}

function resolveOutputDirectory(rootPath: string): string {
  const settings = vscode.workspace.getConfiguration("tiecode");
  const configured = settings.get<string>("build.outputDirectory") ?? path.join(rootPath, BUILD_DIR_NAME);
  return resolveMaybeRelative(rootPath, configured);
}

function detectProjectKind(rootPath: string, config: TiecodeProjectConfig): ProjectKind {
  const configKind = normalizeProjectKind(config.type);
  if (configKind) {
    return configKind;
  }

  const settings = vscode.workspace.getConfiguration("tiecode");
  const platformSetting = settings.get<string>("project.platform") ?? "auto";
  const settingPlatform = normalizePlatformName(platformSetting);
  if (settingPlatform === "android") {
    return "android";
  }
  if (settingPlatform === "html") {
    return "html";
  }
  if (settingPlatform === "windows" || settingPlatform === "linux") {
    return "cxx";
  }

  return detectKindFromSources(rootPath) ?? "android";
}

function detectPlatformName(kind: ProjectKind, config: TiecodeProjectConfig): PlatformName {
  if (kind === "android") {
    return "android";
  }
  if (kind === "html") {
    return "html";
  }

  const settings = vscode.workspace.getConfiguration("tiecode");
  const cxxTarget = normalizePlatformName(config.cxx?.target);
  const settingTarget = normalizePlatformName(settings.get<string>("project.platform"));
  if (cxxTarget === "windows" || cxxTarget === "linux") {
    return cxxTarget;
  }
  if (settingTarget === "windows" || settingTarget === "linux") {
    return settingTarget;
  }
  return process.platform === "win32" ? "windows" : "linux";
}

function detectKindFromSources(rootPath: string): ProjectKind | undefined {
  const roots = collectProjectSourceRoots(rootPath);
  const files = scanTiecodeFiles(roots).slice(0, 50);
  for (const file of files) {
    const text = safeReadStart(file);
    if (/类\s+启动页\s*:\s*网页/.test(text)) {
      return "html";
    }
    if (/类\s+启动窗口\s*:\s*窗口/.test(text)) {
      return "android";
    }
    if (/类\s+启动类\b/.test(text)) {
      return "cxx";
    }
  }
  return undefined;
}

function safeReadStart(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, 16384);
  } catch {
    return "";
  }
}

function scanDirectory(root: string, files: string[]): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) {
        scanDirectory(fullPath, files);
      }
      continue;
    }

    if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".t")) {
      files.push(fullPath);
    }
  }
}

function shouldSkipDirectory(name: string): boolean {
  return name === ".git" || name === ".vscode" || name === "node_modules" || name === "out" || name === BUILD_DIR_NAME;
}

function defaultTiecPath(compilerRoot: string): string {
  if (process.platform === "win32") {
    return path.join(compilerRoot, "prebuilt", "cli", "windows", "x64", "tiec.exe");
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return path.join(compilerRoot, "prebuilt", "cli", "linux", "aarch64", "tiec");
  }
  return path.join(compilerRoot, "prebuilt", "cli", "linux", "x86_64", "tiec");
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map(value => path.normalize(value))));
}
