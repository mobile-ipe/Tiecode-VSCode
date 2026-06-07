export type ProjectKind = "android" | "cxx" | "html";

export type PlatformName = "android" | "windows" | "linux" | "html";

export interface AndroidProjectConfig {
  appName?: string;
  package?: string;
  packageName?: string;
  minSdk?: number;
  targetSdk?: number;
  versionCode?: number;
  versionName?: string;
  iconPath?: string;
  gradle?: boolean;
  foundationLibPath?: string;
}

export interface IpeProjectConfigFields {
  app_name?: string;
  app_pkg?: string;
  package?: string;
  min_sdk?: number;
  target_sdk?: number;
  version_code?: number;
  version_name?: string;
  icon_path?: string;
  source_version?: number;
  project_version?: number;
}

export interface CxxProjectConfig {
  target?: "windows" | "linux";
  executableName?: string;
  useCmake?: boolean;
}

export interface HtmlProjectConfig {
  title?: string;
}

export interface ProjectCompilerConfig {
  root?: string;
  tiecPath?: string;
  stdlibsPath?: string;
}

export interface TiecodeProjectConfig extends IpeProjectConfigFields {
  type?: string;
  name?: string;
  packageName?: string;
  sourceVersion?: number;
  android?: AndroidProjectConfig;
  cxx?: CxxProjectConfig;
  html?: HtmlProjectConfig;
  compiler?: ProjectCompilerConfig;
}

export interface CompilerPaths {
  rootPath: string;
  tiecPath: string;
  stdlibsPath: string;
}

export interface ProjectInfo {
  rootPath: string;
  configPath: string;
  config: TiecodeProjectConfig;
  kind: ProjectKind;
  platformName: PlatformName;
  platformNumber: number;
  packageName: string;
  sourceVersion: number;
  outputDir: string;
  lineMapPath: string;
  sourceRoots: string[];
  projectSourceRoots: string[];
  stdlibSourceRoot?: string;
  sourceFiles: string[];
  compiler: CompilerPaths;
}

export interface NativeSession {
  project: ProjectInfo;
  module: unknown;
  tiec: any;
  service: any;
}

export interface BuildRequest {
  kind: ProjectKind;
  platformName?: PlatformName;
}

export const SOURCE_DIR_NAME = "源代码";
export const LIB_DIR_NAME = "绳包";
export const BUILD_DIR_NAME = "build";
export const PROJECT_CONFIG_FILE = "project.json";
export const EXTENSION_CONFIG_FILE = "tiecode.project.json";

export const TARGET_PLATFORM_NUMBER: Record<PlatformName, number> = {
  android: 1,
  linux: 3,
  windows: 4,
  html: 7
};
