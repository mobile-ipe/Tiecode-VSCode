import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { LIB_DIR_NAME, ProjectKind, SOURCE_DIR_NAME } from "./types";
import { basicLibraryFolderName, createProjectConfig, ensureDirectory, getBundledStdlibsPath, resolveBundledStdlibSourceRoot, writeProjectConfig, writeTextFile } from "./workspace";

export function registerTemplateCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tiecode.createAndroidProject", () => createProject("android")),
    vscode.commands.registerCommand("tiecode.createCxxProject", () => createProject("cxx")),
    vscode.commands.registerCommand("tiecode.createHtmlProject", () => createProject("html"))
  );
}

export interface CreateProjectOptions {
  forcePickBaseRoot?: boolean;
  openAfterCreate?: boolean;
}

export async function createProject(kind: ProjectKind, options: CreateProjectOptions = {}): Promise<void> {
  const baseRoot = await pickBaseRoot(options.forcePickBaseRoot);
  if (!baseRoot) {
    return;
  }

  const defaultName = kind === "android" ? "我的应用" : kind === "html" ? "TiecodeWebApp" : "TiecodeCxxApp";
  const name = await vscode.window.showInputBox({
    title: "结绳工程名称",
    value: defaultName,
    validateInput: value => value.trim().length === 0 ? "请输入工程名称" : undefined
  });
  if (!name) {
    return;
  }

  const rootPath = path.join(baseRoot, sanitizeFileName(name));
  if (fs.existsSync(rootPath) && fs.readdirSync(rootPath).length > 0) {
    const answer = await vscode.window.showWarningMessage("目标目录不是空目录，继续会覆盖同名模板文件和基本库。", "继续");
    if (answer !== "继续") {
      return;
    }
  }

  try {
    ensureDirectory(path.join(rootPath, SOURCE_DIR_NAME));
    ensureDirectory(path.join(rootPath, LIB_DIR_NAME));
    copyProjectBasicLibrary(rootPath, kind);
    writeProjectConfig(rootPath, createProjectConfig(kind, name));
    writeTemplateFiles(rootPath, kind, name);
  } catch (error) {
    void vscode.window.showErrorMessage(`创建结绳工程失败: ${String(error instanceof Error ? error.message : error)}`);
    return;
  }

  if (options.openAfterCreate) {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(rootPath), false);
    return;
  }

  const openFolder = await vscode.window.showInformationMessage(`结绳工程已创建: ${rootPath}`, "打开工程");
  if (openFolder === "打开工程") {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(rootPath), false);
  }
}

function writeTemplateFiles(rootPath: string, kind: ProjectKind, name: string): void {
  if (kind === "android") {
    writeTextFile(path.join(rootPath, SOURCE_DIR_NAME, "启动窗口.t"), androidTemplate());
    return;
  }

  if (kind === "html") {
    writeTextFile(path.join(rootPath, SOURCE_DIR_NAME, "启动页.t"), htmlTemplate());
    return;
  }

  writeTextFile(path.join(rootPath, SOURCE_DIR_NAME, "启动类.t"), cxxTemplate());
  writeTextFile(path.join(rootPath, "CMakeLists.txt"), cmakeTemplate(name));
}

function copyProjectBasicLibrary(rootPath: string, kind: ProjectKind): void {
  const stdlibSourceRoot = resolveBundledStdlibSourceRoot(kind);
  const libraryName = basicLibraryFolderName(kind);
  if (!stdlibSourceRoot) {
    throw new Error(`未找到插件内置${libraryName}: ${getBundledStdlibsPath()}`);
  }

  const libraryRoot = path.dirname(stdlibSourceRoot);
  const targetRoot = path.join(rootPath, LIB_DIR_NAME, libraryName);
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.cpSync(libraryRoot, targetRoot, { recursive: true });
}

async function pickBaseRoot(forcePick = false): Promise<string | undefined> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot && !forcePick) {
    return workspaceRoot;
  }

  const picked = await vscode.window.showOpenDialog({
    title: "选择结绳工程父目录",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false
  });
  return picked?.[0]?.fsPath;
}

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[<>:"/\\|?*]+/g, "_");
}

function androidTemplate(): string {
  return [
    "类 启动窗口 : 窗口",
    "    @组件配置({宽度=-1, 高度=-1, 纵向布局=真, 内边距=\"16dp\"}, 根布局=真)",
    "    变量 根布局 : 线性布局",
    "",
    "    @组件配置({内容=\"你好，结绳\", 宽度=-1, 高度=-2, 字体大小=\"20sp\"}, 父布局=根布局)",
    "    变量 标题 : 文本框",
    "",
    "    事件 启动窗口:创建完毕()",
    "        弹出提示(\"工程创建成功\")",
    "    结束 事件",
    "结束 类",
    ""
  ].join("\n");
}

function htmlTemplate(): string {
  return [
    "类 启动页 : 网页",
    "    @组件配置({宽度=\"100%\", 纵向布局=真}, 根布局=真)",
    "    变量 根布局 : 线性布局",
    "",
    "    @组件配置({内容=\"你好，结绳\", 字体大小=\"20px\"}, 父布局=根布局)",
    "    变量 标题 : 文本框",
    "",
    "    事件 启动页:创建完毕()",
    "        弹出提示(\"工程创建成功\")",
    "    结束 事件",
    "结束 类",
    ""
  ].join("\n");
}

function cxxTemplate(): string {
  return [
    "类 启动类",
    "    方法 启动方法()",
    "        基本工具.调试输出(\"你好，结绳\")",
    "    结束 方法",
    "结束 类",
    ""
  ].join("\n");
}

function cmakeTemplate(name: string): string {
  const target = sanitizeFileName(name);
  return [
    "cmake_minimum_required(VERSION 3.16)",
    `project(${target})`,
    "",
    "set(CMAKE_CXX_STANDARD 14)",
    "set(CMAKE_CXX_STANDARD_REQUIRED ON)",
    "",
    "file(GLOB_RECURSE TIECODE_GENERATED CONFIGURE_DEPENDS \"build/*.cpp\" \"build/*.cxx\" \"build/*.cc\")",
    `add_executable(${target} \${TIECODE_GENERATED})`,
    ""
  ].join("\n");
}
