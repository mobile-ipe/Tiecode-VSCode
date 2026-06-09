export type ProjectKind = "android" | "cxx" | "html";

export type PlatformName = "android" | "windows" | "linux" | "html";

export type BuildMode = "debug" | "release";

export type DefineValue = string | number | boolean | null;

export interface AndroidProjectConfig {
  appName?: string;
  package?: string;
  packageName?: string;
  minSdk?: number;
  targetSdk?: number;
  versionCode?: number;
  versionName?: string;
  iconPath?: string;
}

export interface IpeProjectConfigFields {
  typeId?: string;
  classification_id?: string;
  classification?: string;
  project_name?: string;
  project_kind?: number;
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
  macro_definitions?: string;
}

export interface CxxProjectConfig {
  target?: "windows" | "linux";
  executableName?: string;
  runCmake?: boolean;
  cmakeCommand?: string;
  cmakeGenerator?: string;
  cmakeBuildType?: string;
  cmakeBuildDirectory?: string;
}

export interface HtmlProjectConfig {
  title?: string;
}

export interface TiecodeProjectConfig extends IpeProjectConfigFields {
  type?: string;
  name?: string;
  packageName?: string;
  sourceVersion?: number;
  buildMode?: BuildMode;
  defines?: Record<string, DefineValue>;
  android?: AndroidProjectConfig;
  cxx?: CxxProjectConfig;
  html?: HtmlProjectConfig;
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
