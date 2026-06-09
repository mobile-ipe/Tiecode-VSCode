import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  BUILD_DIR_NAME,
  BuildMode,
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

interface ProjectConfigLoadResult {
  configPath: string;
  config: TiecodeProjectConfig;
}

const PROJECT_KIND_TYPE_IDS: Record<ProjectKind, string> = {
  android: "cn.tiecode.android",
  cxx: "cn.tiecode.linux",
  html: "cn.tiecode.html"
};

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
  if (!rootPath || !hasProjectConfig(rootPath)) {
    return undefined;
  }

  const { configPath, config } = readProjectConfig(rootPath);
  const kind = overrideKind ?? detectProjectKind(config);
  const platformName = detectPlatformName(kind, config);
  const sourceVersion = normalizeSourceVersion(config.sourceVersion);
  const outputDir = resolveOutputDirectory(rootPath);
  const lineMapPath = path.join(outputDir, "mapping.bin");
  const projectSourceRoots = collectProjectSourceRoots(rootPath);
  const projectStdlibSourceRoot = resolveProjectStdlibSourceRoot(rootPath, kind);
  const bundledStdlibSourceRoot = resolveBundledStdlibSourceRoot(kind);
  const stdlibSourceRoot = projectStdlibSourceRoot ?? bundledStdlibSourceRoot;
  const fallbackStdlibRoots = projectStdlibSourceRoot ? [] : (bundledStdlibSourceRoot ? [bundledStdlibSourceRoot] : []);
  const sourceRoots = dedupe([...projectSourceRoots, ...fallbackStdlibRoots]);
  const sourceFiles = scanTiecodeFiles(sourceRoots);

  return {
    rootPath,
    configPath,
    config,
    kind,
    platformName,
    platformNumber: TARGET_PLATFORM_NUMBER[platformName],
    packageName: config.packageName ?? config.android?.packageName ?? config.android?.package ?? "我的.安卓.应用",
    sourceVersion,
    outputDir,
    lineMapPath,
    sourceRoots,
    projectSourceRoots,
    stdlibSourceRoot,
    sourceFiles
  };
}

export function readProjectConfig(rootPath: string): ProjectConfigLoadResult {
  const ipeConfigPath = getProjectConfigPath(rootPath);
  const extensionConfigPath = path.join(rootPath, EXTENSION_CONFIG_FILE);
  const ipeConfig = normalizeProjectConfig(readJsonFile(ipeConfigPath));
  const extensionConfig = normalizeProjectConfig(readJsonFile(extensionConfigPath));

  return {
    configPath: ipeConfigPath,
    config: mergeProjectConfig(ipeConfig, extensionConfig)
  };
}

export function getProjectConfigPath(rootPath: string): string {
  return path.join(rootPath, PROJECT_CONFIG_FILE);
}

export function hasProjectConfig(rootPath: string): boolean {
  return fs.existsSync(getProjectConfigPath(rootPath));
}

export function createProjectConfig(kind: ProjectKind, name: string): TiecodeProjectConfig {
  if (kind === "android") {
    return {
      typeId: projectKindTypeId("android"),
      app_name: name,
      app_pkg: "我的.安卓.应用",
      project_version: 2,
      source_version: 47,
      min_sdk: 21,
      target_sdk: 28,
      version_code: 1,
      version_name: "1.0",
      icon_path: "",
      macro_definitions: ""
    };
  }

  if (kind === "html") {
    return {
      typeId: projectKindTypeId("html"),
      app_name: name,
      source_version: 47,
      html: {
        title: name
      }
    };
  }

  return {
    typeId: projectKindTypeId("cxx"),
    app_name: name,
    source_version: 47,
    cxx: {
      target: process.platform === "win32" ? "windows" : "linux",
      executableName: name,
      runCmake: true
    }
  };
}

export function looksLikeTiecodeWorkspace(rootPath: string): boolean {
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    return false;
  }

  if (fs.existsSync(path.join(rootPath, SOURCE_DIR_NAME)) || fs.existsSync(path.join(rootPath, LIB_DIR_NAME))) {
    return true;
  }

  return hasTiecodeRelatedFile(rootPath, 3);
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
  const configKind = normalizeProjectKind(readProjectKindField(raw));
  const androidLike = configKind === "android" || (!configKind && (Boolean(raw.android) || hasAndroidConfig(raw)));

  const displayName = raw.name ?? raw.project_name ?? raw.app_name;
  if (displayName && !config.name) {
    config.name = displayName;
  }
  if (raw.source_version !== undefined && config.sourceVersion === undefined) {
    config.sourceVersion = raw.source_version;
  }
  if (raw.macro_definitions && !config.defines) {
    config.defines = parseMacroDefinitions(raw.macro_definitions);
  }

  const packageName = raw.app_pkg ?? raw.package;
  if (androidLike && packageName && !config.packageName) {
    config.packageName = packageName;
  }
  if (configKind && !config.typeId) {
    config.typeId = projectKindTypeId(configKind);
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
  if (!config.typeId && androidLike) {
    config.typeId = PROJECT_KIND_TYPE_IDS.android;
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
  return normalizeDefines({
    ...parseMacroDefinitions(config.macro_definitions ?? ""),
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

export function resolveStdlibSourceRoot(stdlibsPath: string, kind: ProjectKind): string | undefined {
  const folderName = kind === "android" ? "安卓基本库" : kind === "html" ? "网页基本库" : "CXX基本库";
  const sourceRoot = path.join(stdlibsPath, folderName, SOURCE_DIR_NAME);
  return fs.existsSync(sourceRoot) ? sourceRoot : undefined;
}

export function resolveBundledStdlibSourceRoot(kind: ProjectKind): string | undefined {
  return resolveStdlibSourceRoot(getBundledStdlibsPath(), kind);
}

export function getBundledStdlibsPath(): string {
  return path.join(getExtensionRoot(), "assets", "stdlibs");
}

export function getExtensionRoot(): string {
  return path.resolve(__dirname, "..", "..");
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
  } else {
    roots.push(rootPath);
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

export function projectKindTypeId(kind: ProjectKind): string {
  return PROJECT_KIND_TYPE_IDS[kind];
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
  if (normalized === "android" || normalized === "安卓" || normalized === "cn.tiecode.android" || normalized.includes("安卓")) {
    return "android";
  }
  if (normalized === "html" || normalized === "web" || normalized === "webpage" || normalized === "网页" || normalized === "cn.tiecode.html" || normalized === "cn.tiecode.web" || normalized.includes("网页")) {
    return "html";
  }
  if (normalized === "cxx" || normalized === "cpp" || normalized === "linux" || normalized === "windows" || normalized === "cn.tiecode.linux" || normalized === "cn.tiecode.cxx" || normalized === "cn.tiecode.windows" || normalized.includes("linux")) {
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
  const configured = Number(value ?? 47);
  return configured === 40 || configured === 46 || configured === 47 ? configured : 47;
}

export function getProjectBuildMode(config: TiecodeProjectConfig): BuildMode {
  return normalizeBuildMode(config.buildMode) ?? "debug";
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
  return path.join(rootPath, BUILD_DIR_NAME);
}

function detectProjectKind(config: TiecodeProjectConfig): ProjectKind {
  const configKind = normalizeProjectKind(readProjectKindField(config));
  if (configKind) {
    return configKind;
  }

  return "android";
}

function detectPlatformName(kind: ProjectKind, config: TiecodeProjectConfig): PlatformName {
  if (kind === "android") {
    return "android";
  }
  if (kind === "html") {
    return "html";
  }

  const cxxTarget = normalizePlatformName(config.cxx?.target);
  if (cxxTarget === "windows" || cxxTarget === "linux") {
    return cxxTarget;
  }
  return process.platform === "win32" ? "windows" : "linux";
}

function readProjectKindField(config: TiecodeProjectConfig): unknown {
  return config.typeId ?? config.classification_id ?? config.type ?? config.classification;
}

function parseMacroDefinitions(text: string): Record<string, DefineValue> {
  const values: Record<string, DefineValue> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) {
      values[line] = null;
      continue;
    }
    const name = line.slice(0, equalsIndex).trim();
    if (!name) {
      continue;
    }
    values[name] = parseMacroValue(line.slice(equalsIndex + 1).trim());
  }
  return values;
}

function parseMacroValue(value: string): DefineValue {
  if (value === "true" || value === "真") {
    return true;
  }
  if (value === "false" || value === "假") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (/^-?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1);
  }
  return value;
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

function hasTiecodeRelatedFile(root: string, maxDepth: number): boolean {
  let visited = 0;

  const scan = (dir: string, depth: number): boolean => {
    if (visited > 2000) {
      return false;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      visited += 1;
      const lowerName = entry.name.toLocaleLowerCase();
      if (entry.isFile() && (lowerName.endsWith(".t") || lowerName.endsWith(".tly"))) {
        return true;
      }
      if (entry.isDirectory() && depth > 0 && !shouldSkipDirectory(entry.name)) {
        if (scan(path.join(dir, entry.name), depth - 1)) {
          return true;
        }
      }
    }
    return false;
  };

  return scan(root, maxDepth);
}

function shouldSkipDirectory(name: string): boolean {
  return name === ".git" || name === ".vscode" || name === "node_modules" || name === "out" || name === BUILD_DIR_NAME;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map(value => path.normalize(value))));
}
