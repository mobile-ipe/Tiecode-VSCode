import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  BUILD_DIR_NAME,
  BuildMode,
  CompilerPaths,
  DefineValue,
  EXTENSION_CONFIG_FILE,
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

interface ProjectConfigLoadResult {
  configPath: string;
  config: TiecodeProjectConfig;
}

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

  const { configPath, config } = readProjectConfig(rootPath);
  const kind = overrideKind ?? detectProjectKind(rootPath, config);
  const platformName = detectPlatformName(kind, config);
  const sourceVersion = normalizeSourceVersion(config.sourceVersion);
  const compiler = resolveCompilerPaths(rootPath, config);
  const outputDir = resolveOutputDirectory(rootPath);
  const lineMapPath = path.join(outputDir, "mapping.bin");
  const projectSourceRoots = collectProjectSourceRoots(rootPath);
  const projectStdlibSourceRoot = resolveProjectStdlibSourceRoot(rootPath, kind);
  const compilerStdlibSourceRoot = resolveStdlibSourceRoot(compiler.stdlibsPath, kind);
  const stdlibSourceRoot = projectStdlibSourceRoot ?? compilerStdlibSourceRoot;
  const fallbackStdlibRoots = projectStdlibSourceRoot ? [] : (compilerStdlibSourceRoot ? [compilerStdlibSourceRoot] : []);
  const sourceRoots = dedupe([...projectSourceRoots, ...fallbackStdlibRoots]);
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

export function readProjectConfig(rootPath: string): ProjectConfigLoadResult {
  const ipeConfigPath = path.join(rootPath, PROJECT_CONFIG_FILE);
  const extensionConfigPath = path.join(rootPath, EXTENSION_CONFIG_FILE);
  const ipeConfig = normalizeProjectConfig(readJsonFile(ipeConfigPath));
  const extensionConfig = normalizeProjectConfig(readJsonFile(extensionConfigPath));

  return {
    configPath: fs.existsSync(ipeConfigPath) ? ipeConfigPath : extensionConfigPath,
    config: mergeProjectConfig(ipeConfig, extensionConfig)
  };
}

export function readProjectFileConfig(rootPath: string): TiecodeProjectConfig {
  return readJsonFile(path.join(rootPath, PROJECT_CONFIG_FILE));
}

function readJsonFile(configPath: string): TiecodeProjectConfig {
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

function normalizeProjectConfig(raw: TiecodeProjectConfig): TiecodeProjectConfig {
  const config: TiecodeProjectConfig = { ...raw };
  const android = { ...(raw.android ?? {}) };
  const androidLike = Boolean(raw.android) || hasAndroidConfig(raw) || normalizeProjectKind(raw.type) === "android";

  if (raw.app_name && !config.name) {
    config.name = raw.app_name;
  }
  if (raw.source_version !== undefined && config.sourceVersion === undefined) {
    config.sourceVersion = raw.source_version;
  }

  const packageName = raw.app_pkg ?? raw.package;
  if (packageName && !config.packageName) {
    config.packageName = packageName;
  }

  if (androidLike) {
    if (raw.app_name && !android.appName) {
      android.appName = raw.app_name;
    }
    if (packageName && !android.packageName) {
      android.packageName = packageName;
    }
    if (raw.min_sdk !== undefined && android.minSdk === undefined) {
      android.minSdk = raw.min_sdk;
    }
    if (raw.target_sdk !== undefined && android.targetSdk === undefined) {
      android.targetSdk = raw.target_sdk;
    }
    if (raw.version_code !== undefined && android.versionCode === undefined) {
      android.versionCode = raw.version_code;
    }
    if (raw.version_name !== undefined && android.versionName === undefined) {
      android.versionName = raw.version_name;
    }
    if (raw.icon_path !== undefined && android.iconPath === undefined) {
      android.iconPath = raw.icon_path;
    }
    config.android = android;
  }
  if (!config.type && androidLike) {
    config.type = "android";
  }

  return config;
}

function mergeProjectConfig(base: TiecodeProjectConfig, override: TiecodeProjectConfig): TiecodeProjectConfig {
  const config: TiecodeProjectConfig = {
    ...base,
    ...override
  };
  const android = { ...(base.android ?? {}), ...(override.android ?? {}) };
  const cxx = { ...(base.cxx ?? {}), ...(override.cxx ?? {}) };
  const html = { ...(base.html ?? {}), ...(override.html ?? {}) };
  const compiler = { ...(base.compiler ?? {}), ...(override.compiler ?? {}) };
  const defines = { ...(base.defines ?? {}), ...(override.defines ?? {}) };

  if (Object.keys(android).length > 0) {
    config.android = android;
  }
  if (Object.keys(cxx).length > 0) {
    config.cxx = cxx;
  }
  if (Object.keys(html).length > 0) {
    config.html = html;
  }
  if (Object.keys(compiler).length > 0) {
    config.compiler = compiler;
  }
  if (Object.keys(defines).length > 0) {
    config.defines = normalizeDefines(defines);
  }
  return config;
}

function hasAndroidConfig(config: TiecodeProjectConfig): boolean {
  return config.app_pkg !== undefined ||
    config.min_sdk !== undefined ||
    config.target_sdk !== undefined ||
    config.version_code !== undefined ||
    config.version_name !== undefined ||
    config.icon_path !== undefined;
}

export function writeProjectConfig(rootPath: string, config: TiecodeProjectConfig): void {
  fs.writeFileSync(path.join(rootPath, PROJECT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function updateProjectConfig(rootPath: string, update: (config: TiecodeProjectConfig) => void): TiecodeProjectConfig {
  const config = readProjectFileConfig(rootPath);
  update(config);
  writeProjectConfig(rootPath, config);
  return config;
}

export function getProjectDefines(config: TiecodeProjectConfig): Record<string, DefineValue> {
  const settings = vscode.workspace.getConfiguration("tiecode");
  const configured = settings.get<Record<string, DefineValue>>("build.defines") ?? {};
  return normalizeDefines({
    ...configured,
    ...(config.defines ?? {})
  });
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

export function resolveProjectStdlibSourceRoot(rootPath: string, kind: ProjectKind): string | undefined {
  for (const folderName of projectBasicLibraryFolderNames(kind)) {
    const sourceRoot = path.join(rootPath, LIB_DIR_NAME, folderName, SOURCE_DIR_NAME);
    if (fs.existsSync(sourceRoot)) {
      return sourceRoot;
    }
  }
  return undefined;
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

export function isTlyDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "tly" || document.fileName.toLocaleLowerCase().endsWith(".tly");
}

export function isTiecodeRelatedDocument(document: vscode.TextDocument): boolean {
  return isTiecodeDocument(document) || isTlyDocument(document);
}

export function isProjectConfigUri(uri: vscode.Uri): boolean {
  const fileName = path.basename(uri.fsPath);
  return fileName === PROJECT_CONFIG_FILE || fileName === EXTENSION_CONFIG_FILE || fileName === "lib.json";
}

export function projectKindDisplayName(kind: ProjectKind): string {
  if (kind === "android") {
    return "结绳安卓工程";
  }
  if (kind === "html") {
    return "结绳网页工程";
  }
  return "结绳 CXX 工程";
}

export function basicLibraryFolderName(kind: ProjectKind): string {
  if (kind === "android") {
    return "安卓基本库";
  }
  if (kind === "html") {
    return "网页基本库";
  }
  return "CXX基本库";
}

function projectBasicLibraryFolderNames(kind: ProjectKind): string[] {
  if (kind === "cxx") {
    return ["CXX基本库", "Linux基本库"];
  }
  return [basicLibraryFolderName(kind)];
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

export function getProjectBuildMode(config: TiecodeProjectConfig): BuildMode {
  const settings = vscode.workspace.getConfiguration("tiecode");
  return normalizeBuildMode(config.buildMode ?? settings.get<string>("build.mode")) ?? "debug";
}

export function normalizeBuildMode(value: unknown): BuildMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLocaleLowerCase();
  if (normalized === "release" || normalized === "正式" || normalized === "正式包") {
    return "release";
  }
  if (normalized === "debug" || normalized === "调试" || normalized === "调试包") {
    return "debug";
  }
  return undefined;
}

export function normalizeDefines(values: Record<string, unknown>): Record<string, DefineValue> {
  const defines: Record<string, DefineValue> = {};
  for (const [rawName, rawValue] of Object.entries(values)) {
    const name = rawName.trim();
    if (!name) {
      continue;
    }
    if (rawValue === null || typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") {
      defines[name] = rawValue;
      continue;
    }
    if (rawValue !== undefined) {
      defines[name] = String(rawValue);
    }
  }
  return defines;
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
