import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { buildTiecodeProject, resolveCMakeBuildDirectory, runTool } from "./build";
import { AndroidLogcatService } from "./logcat";
import { SourceMappingService } from "./sourceMapping";
import { ToolchainService } from "./toolchain";
import { ProjectInfo, ProjectKind } from "./types";
import { TiecodeWasmBuildService } from "./wasmBuild";
import { getProjectBuildMode, getProjectInfo, normalizeProjectKind } from "./workspace";

interface TiecodeDebugConfiguration extends vscode.DebugConfiguration {
  projectKind?: ProjectKind | "auto";
}

export function registerRunCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  toolchain: ToolchainService,
  sourceMapping: SourceMappingService,
  logcat: AndroidLogcatService,
  compiler: TiecodeWasmBuildService
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tiecode.runProject", () => runTiecodeProject(output, toolchain, sourceMapping, logcat, compiler)),
    vscode.debug.registerDebugConfigurationProvider("tiecode", new TiecodeDebugConfigurationProvider(output, toolchain, sourceMapping, logcat, compiler))
  );
}

export async function runTiecodeProject(
  output: vscode.OutputChannel,
  toolchain: ToolchainService,
  sourceMapping: SourceMappingService,
  logcat: AndroidLogcatService,
  compiler: TiecodeWasmBuildService,
  requestedKind?: ProjectKind
): Promise<void> {
  output.clear();
  output.show(true);
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "正在运行结绳工程",
    cancellable: false
  }, async () => {
    try {
      const project = resolveRunProject(requestedKind);
      if (project.kind === "android") {
        await runAndroidProject(project, output, toolchain, sourceMapping, logcat, compiler);
        return;
      }
      if (project.kind === "cxx") {
        await runCxxProject(project, output, compiler);
        return;
      }
      await runHtmlProject(project, output, compiler);
    } catch (error) {
      void vscode.window.showErrorMessage(`结绳运行失败: ${String(error instanceof Error ? error.message : error)}`);
    }
  });
}

class TiecodeDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly toolchain: ToolchainService,
    private readonly sourceMapping: SourceMappingService,
    private readonly logcat: AndroidLogcatService,
    private readonly compiler: TiecodeWasmBuildService
  ) {}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [
      {
        type: "tiecode",
        request: "launch",
        name: "运行结绳工程",
        projectKind: "auto"
      }
    ];
  }

  async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: TiecodeDebugConfiguration
  ): Promise<vscode.DebugConfiguration | undefined> {
    const projectKind = normalizeProjectKind(config.projectKind);
    await runTiecodeProject(this.output, this.toolchain, this.sourceMapping, this.logcat, this.compiler, projectKind);
    return undefined;
  }
}

function resolveRunProject(requestedKind?: ProjectKind): ProjectInfo {
  const project = getProjectInfo(vscode.window.activeTextEditor?.document.uri, requestedKind);
  if (!project) {
    throw new Error("没有打开结绳工作区。");
  }
  return project;
}

async function runAndroidProject(
  project: ProjectInfo,
  output: vscode.OutputChannel,
  toolchain: ToolchainService,
  sourceMapping: SourceMappingService,
  logcat: AndroidLogcatService,
  compiler: TiecodeWasmBuildService
): Promise<void> {
  const buildMode = getProjectBuildMode(project.config);
  const androidToolchain = await toolchain.prepareAndroidToolchain(project);
  const gradleTask = buildMode === "release" ? "assembleRelease" : "installDebug";
  const builtProject = await buildTiecodeProject(
    { kind: "android", platformName: "android" },
    output,
    { buildMode, gradleTask, runGradle: true, env: androidToolchain.env, sourceMapping, compiler }
  );
  if (buildMode === "release") {
    output.appendLine("Android 正式包已构建，未自动安装运行。");
    return;
  }
  const component = resolveAndroidLaunchComponent(builtProject);
  await runTool(androidToolchain.adbPath, ["logcat", "-c"], builtProject.rootPath, output, false, androidToolchain.env)
    .catch(error => output.appendLine(`清理 logcat 失败: ${String(error instanceof Error ? error.message : error)}`));
  await logcat.start(builtProject, androidToolchain.adbPath, androidToolchain.env, output, sourceMapping);
  output.appendLine(`启动 Android Activity: ${component}`);
  await runTool(androidToolchain.adbPath, ["shell", "am", "start", "-n", component], builtProject.rootPath, output, false, androidToolchain.env);
}

async function runCxxProject(project: ProjectInfo, output: vscode.OutputChannel, compiler: TiecodeWasmBuildService): Promise<void> {
  const builtProject = await buildTiecodeProject(
    { kind: "cxx", platformName: project.platformName },
    output,
    { runCmake: true, compiler }
  );
  const executable = findCxxExecutable(builtProject);
  output.appendLine(`启动 CXX 程序: ${executable}`);
  await runTool(executable, [], path.dirname(executable), output, false);
}

async function runHtmlProject(project: ProjectInfo, output: vscode.OutputChannel, compiler: TiecodeWasmBuildService): Promise<void> {
  const builtProject = await buildTiecodeProject(
    { kind: "html", platformName: "html" },
    output,
    { compiler }
  );
  const htmlPath = findHtmlEntry(builtProject.outputDir);
  output.appendLine(`打开网页工程: ${htmlPath}`);
  await vscode.env.openExternal(vscode.Uri.file(htmlPath));
}

function resolveAndroidLaunchComponent(project: ProjectInfo): string {
  const activityName = findLauncherActivity(project);
  return `${project.packageName}/${normalizeAndroidActivityName(project.packageName, activityName)}`;
}

function findLauncherActivity(project: ProjectInfo): string {
  const manifestPath = path.join(project.outputDir, "app", "src", "main", "AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`未找到 AndroidManifest.xml: ${manifestPath}`);
  }

  const manifest = fs.readFileSync(manifestPath, "utf8");
  const activityPattern = /<activity\b([^>]*)>([\s\S]*?)<\/activity>/g;
  for (const match of manifest.matchAll(activityPattern)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    if (!body.includes("android.intent.action.MAIN") || !body.includes("android.intent.category.LAUNCHER")) {
      continue;
    }

    const name = attributes.match(/\bandroid:name\s*=\s*"([^"]+)"/)?.[1];
    if (name) {
      return name;
    }
  }

  throw new Error(`未找到 Android 启动 Activity: ${manifestPath}`);
}

function normalizeAndroidActivityName(packageName: string, activityName: string): string {
  if (activityName.startsWith(".")) {
    return `${packageName}${activityName}`;
  }
  if (!activityName.includes(".")) {
    return `${packageName}.${activityName}`;
  }
  return activityName;
}

function findCxxExecutable(project: ProjectInfo): string {
  const buildDirectory = resolveCMakeBuildDirectory(project);
  const buildType = project.config.cxx?.cmakeBuildType ?? "Debug";
  const targetName = project.config.cxx?.executableName ?? readCMakeTargetName(project) ?? "main";
  const names = Array.from(new Set([targetName, "main", project.config.name].filter(isString)));
  const extension = process.platform === "win32" ? ".exe" : "";
  const directories = [
    path.join(buildDirectory, buildType),
    buildDirectory,
    path.join(buildDirectory, "Debug"),
    path.join(buildDirectory, "Release"),
    path.join(buildDirectory, "RelWithDebInfo")
  ];

  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (isRunnableFile(candidate)) {
        return candidate;
      }
    }
  }

  const found = findRunnableFiles(buildDirectory)
    .filter(file => names.some(name => path.basename(file, extension).toLocaleLowerCase() === name.toLocaleLowerCase()))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
  if (found) {
    return found;
  }

  throw new Error(`未找到 CXX 可执行文件: ${buildDirectory}`);
}

function readCMakeTargetName(project: ProjectInfo): string | undefined {
  const cmakeLists = path.join(project.outputDir, "src", "CMakeLists.txt");
  if (!fs.existsSync(cmakeLists)) {
    return undefined;
  }
  const text = fs.readFileSync(cmakeLists, "utf8");
  return text.match(/\badd_executable\s*\(\s*([^\s)]+)/)?.[1];
}

function findHtmlEntry(outputDir: string): string {
  const candidates = [
    path.join(outputDir, "index.html"),
    path.join(outputDir, "src", "index.html")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const found = findFiles(outputDir, file => path.basename(file).toLocaleLowerCase() === "index.html")[0];
  if (found) {
    return found;
  }
  throw new Error(`未找到网页入口: ${outputDir}`);
}

function findRunnableFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) {
    return [];
  }
  if (process.platform === "win32") {
    return findFiles(rootPath, file => file.toLocaleLowerCase().endsWith(".exe"));
  }
  return findFiles(rootPath, file => isRunnableFile(file));
}

function findFiles(rootPath: string, predicate: (file: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== ".git" && entry.name !== "CMakeFiles") {
        files.push(...findFiles(fullPath, predicate));
      }
      continue;
    }
    if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function isRunnableFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  if (process.platform === "win32") {
    return filePath.toLocaleLowerCase().endsWith(".exe");
  }
  const stat = fs.statSync(filePath);
  return stat.isFile() && (stat.mode & 0o111) !== 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
