import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { TextDecoder } from "util";
import * as vscode from "vscode";
import { ToolchainService } from "./toolchain";
import { BuildMode, BuildRequest, DefineValue, PlatformName, ProjectInfo, ProjectKind } from "./types";
import { ensureDirectory, getProjectBuildMode, getProjectDefines, getProjectInfo, resolveMaybeRelative } from "./workspace";

export interface BuildProjectOptions {
  buildMode?: BuildMode;
  gradleTask?: string;
  runGradle?: boolean;
  runCmake?: boolean;
  env?: NodeJS.ProcessEnv;
  toolchain?: ToolchainService;
}

export function registerBuildCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel, toolchain?: ToolchainService): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tiecode.buildAndroid", () => buildProject({ kind: "android", platformName: "android" }, output, toolchain)),
    vscode.commands.registerCommand("tiecode.buildCxx", () => buildProject({ kind: "cxx" }, output, toolchain)),
    vscode.commands.registerCommand("tiecode.buildHtml", () => buildProject({ kind: "html", platformName: "html" }, output, toolchain))
  );
}

export async function buildProject(request: BuildRequest, output: vscode.OutputChannel, toolchain?: ToolchainService): Promise<void> {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "正在构建结绳工程",
    cancellable: false
  }, async () => {
    try {
      const project = await buildTiecodeProject(request, output, { toolchain });
      void vscode.window.showInformationMessage(`结绳构建完成: ${project.outputDir}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`结绳构建失败: ${String(error instanceof Error ? error.message : error)}`);
    }
  });
}

export async function buildTiecodeProject(
  request: BuildRequest,
  output: vscode.OutputChannel,
  options: BuildProjectOptions = {}
): Promise<ProjectInfo> {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const project = getProjectInfo(uri, request.kind);
  if (!project) {
    throw new Error("没有打开结绳工作区。");
  }

  if (!fs.existsSync(project.compiler.tiecPath)) {
    throw new Error(`找不到 tiec: ${project.compiler.tiecPath}`);
  }

  const buildProjectInfo = { ...project, platformName: request.platformName ?? project.platformName };
  buildProjectInfo.platformNumber = platformNumber(buildProjectInfo.platformName);
  ensureDirectory(buildProjectInfo.outputDir);

  if (buildProjectInfo.sourceFiles.length === 0) {
    throw new Error(`未找到结绳源文件: ${buildProjectInfo.rootPath}`);
  }

  const buildMode = options.buildMode ?? getProjectBuildMode(buildProjectInfo.config);
  const buildOptions = await prepareBuildOptions(buildProjectInfo, { ...options, buildMode });
  const args = createTiecArgs(buildProjectInfo, buildMode);
  output.show(true);
  output.appendLine(`源文件数量: ${buildProjectInfo.sourceFiles.length}`);
  output.appendLine(`> ${project.compiler.tiecPath} ${args.map(quoteArg).join(" ")}`);

  await runProcess(project.compiler.tiecPath, args, project.rootPath, output, buildOptions.env);
  await runGeneratedProjectBuild(buildProjectInfo, output, buildOptions);
  return buildProjectInfo;
}

async function prepareBuildOptions(project: ProjectInfo, options: BuildProjectOptions): Promise<BuildProjectOptions> {
  if (project.kind !== "android" || !options.toolchain || options.env) {
    return options;
  }
  const androidToolchain = await options.toolchain.prepareAndroidToolchain(project);
  return { ...options, env: androidToolchain.env };
}

async function runGeneratedProjectBuild(project: ProjectInfo, output: vscode.OutputChannel, options: BuildProjectOptions): Promise<void> {
  if (project.kind === "android") {
    await runAndroidGradleBuild(project, output, options);
    return;
  }

  if (project.kind === "cxx") {
    await runCxxCMakeBuild(project, output, options);
  }
}

async function runAndroidGradleBuild(project: ProjectInfo, output: vscode.OutputChannel, options: BuildProjectOptions): Promise<void> {
  const settings = vscode.workspace.getConfiguration("tiecode");
  const androidConfig = project.config.android ?? {};
  const generateGradleProject = androidConfig.gradle ?? settings.get<boolean>("android.gradle") ?? true;
  const runGradle = options.runGradle ?? androidConfig.runGradle ?? settings.get<boolean>("android.runGradle") ?? true;
  if (!generateGradleProject || !runGradle) {
    return;
  }

  const gradleRoot = project.outputDir;
  if (!fs.existsSync(path.join(gradleRoot, "settings.gradle")) && !fs.existsSync(path.join(gradleRoot, "build.gradle"))) {
    throw new Error(`未找到 Gradle 工程: ${gradleRoot}`);
  }

  const task = options.gradleTask ?? (options.buildMode === "release" ? "assembleRelease" : "assembleDebug");
  const wrapper = process.platform === "win32"
    ? path.join(gradleRoot, "gradlew.bat")
    : path.join(gradleRoot, "gradlew");
  if (fs.existsSync(wrapper)) {
    await runGradleWrapper(wrapper, [task], gradleRoot, output, options.env);
    return;
  }

  await runTool("gradle", [task], gradleRoot, output, process.platform === "win32", options.env);
}

async function runCxxCMakeBuild(project: ProjectInfo, output: vscode.OutputChannel, options: BuildProjectOptions): Promise<void> {
  const settings = vscode.workspace.getConfiguration("tiecode");
  const cxxConfig = project.config.cxx ?? {};
  const runCmake = options.runCmake ?? cxxConfig.runCmake ?? cxxConfig.useCmake ?? settings.get<boolean>("cxx.runCmake") ?? true;
  if (!runCmake) {
    return;
  }

  const sourceDir = resolveCMakeSourceDirectory(project);
  if (!sourceDir) {
    throw new Error(`未找到 CMakeLists.txt: ${path.join(project.outputDir, "src")} 或 ${project.rootPath}`);
  }

  const cmakeCommand = cxxConfig.cmakeCommand ?? settings.get<string>("cxx.cmakeCommand") ?? "cmake";
  const generator = cxxConfig.cmakeGenerator ?? settings.get<string | null>("cxx.cmakeGenerator");
  const buildType = cxxConfig.cmakeBuildType ?? (options.buildMode === "release" ? "Release" : settings.get<string>("cxx.cmakeBuildType") ?? "Debug");
  const buildDirectory = resolveCMakeBuildDirectory(project);
  ensureDirectory(buildDirectory);

  const configureArgs = ["-S", sourceDir, "-B", buildDirectory];
  if (generator) {
    configureArgs.push("-G", generator);
  }
  if (buildType) {
    configureArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`);
  }
  await runTool(cmakeCommand, configureArgs, project.rootPath, output);

  const buildArgs = ["--build", buildDirectory];
  if (buildType) {
    buildArgs.push("--config", buildType);
  }
  await runTool(cmakeCommand, buildArgs, project.rootPath, output);
}

function createTiecArgs(project: ProjectInfo, buildMode: BuildMode): string[] {
  const args = [
    "--output",
    project.outputDir,
    "--package",
    project.packageName,
    "--source",
    String(project.sourceVersion),
    buildMode === "release" ? "--release" : "--debug",
    "--hard-mode",
    "--enable-toplevel-stmt",
    "--platform",
    project.platformName,
    "--line-map",
    project.lineMapPath
  ];

  if (project.kind === "android") {
    const androidConfigPath = writeAndroidAppConfig(project);
    args.push("--android.app.config", androidConfigPath);
    const androidConfig = project.config.android ?? {};
    const useGradle = androidConfig.gradle ?? vscode.workspace.getConfiguration("tiecode").get<boolean>("android.gradle") ?? true;
    if (useGradle) {
      args.push("--android.gradle");
    }
    const foundationLibPath = androidConfig.foundationLibPath ?? path.dirname(project.stdlibSourceRoot ?? "");
    if (foundationLibPath) {
      args.push("--android.legacy.lib.path", foundationLibPath);
    }
  }

  for (const [name, value] of Object.entries(getProjectDefines(project.config))) {
    args.push("--define", formatDefineArg(name, value));
  }

  args.push(...project.sourceFiles);

  return args;
}

function writeAndroidAppConfig(project: ProjectInfo): string {
  const android = project.config.android ?? {};
  const appConfig = {
    appName: android.appName ?? project.config.name ?? "我的应用",
    appIcon: android.iconPath ?? "",
    minSdk: android.minSdk ?? 21,
    targetSdk: android.targetSdk ?? 28,
    versionCode: android.versionCode ?? 1,
    versionName: android.versionName ?? "1.0"
  };
  const configPath = path.join(project.outputDir, "android-app-config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(appConfig, null, 2)}\n`, "utf8");
  return configPath;
}

function formatDefineArg(name: string, value: DefineValue): string {
  if (value === null) {
    return `${name}=`;
  }
  return `${name}=${String(value)}`;
}

function runProcess(command: string, args: string[], cwd: string, output: vscode.OutputChannel, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, shell: false, env });
    const stdout = new ProcessOutputDecoder(text => output.append(text));
    const stderr = new ProcessOutputDecoder(text => output.append(text));
    child.stdout.on("data", data => stdout.write(data));
    child.stderr.on("data", data => stderr.write(data));
    child.on("error", reject);
    child.on("close", code => {
      stdout.end();
      stderr.end();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tiec 退出码 ${code ?? "unknown"}`));
      }
    });
  });
}

export function runTool(
  command: string,
  args: string[],
  cwd: string,
  output: vscode.OutputChannel,
  shell = process.platform === "win32",
  env?: NodeJS.ProcessEnv
): Promise<void> {
  output.appendLine(`> ${quoteArg(command)} ${args.map(quoteArg).join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, shell, env });
    const stdout = new ProcessOutputDecoder(text => output.append(text));
    const stderr = new ProcessOutputDecoder(text => output.append(text));
    child.stdout.on("data", data => stdout.write(data));
    child.stderr.on("data", data => stderr.write(data));
    child.on("error", reject);
    child.on("close", code => {
      stdout.end();
      stderr.end();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(command)} 退出码 ${code ?? "unknown"}`));
      }
    });
  });
}

function runGradleWrapper(wrapper: string, args: string[], cwd: string, output: vscode.OutputChannel, env?: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform === "win32") {
    return runTool("cmd.exe", ["/d", "/c", "chcp", "65001", ">nul", "&&", "call", wrapper, ...args], cwd, output, false, env);
  }
  return runTool("sh", [wrapper, ...args], cwd, output, false, env);
}

export function resolveCMakeSourceDirectory(project: ProjectInfo): string | undefined {
  const generatedSourceDir = path.join(project.outputDir, "src");
  if (fs.existsSync(path.join(generatedSourceDir, "CMakeLists.txt"))) {
    return generatedSourceDir;
  }
  if (fs.existsSync(path.join(project.rootPath, "CMakeLists.txt"))) {
    return project.rootPath;
  }
  return undefined;
}

export function resolveCMakeBuildDirectory(project: ProjectInfo): string {
  const settings = vscode.workspace.getConfiguration("tiecode");
  const cxxConfig = project.config.cxx ?? {};
  return resolveMaybeRelative(
    project.rootPath,
    cxxConfig.cmakeBuildDirectory ?? settings.get<string>("cxx.cmakeBuildDirectory") ?? "${workspaceFolder}\\build\\cmake"
  );
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, "\\\"")}"` : value;
}

class ProcessOutputDecoder {
  private readonly chunks: Buffer[] = [];
  private decoder?: TextDecoder;

  constructor(private readonly append: (text: string) => void) {}

  write(data: Buffer): void {
    const chunk = Buffer.from(data);
    if (!this.decoder) {
      this.chunks.push(chunk);
      const pending = Buffer.concat(this.chunks);
      if (pending.length < 4096 && !pending.includes(10)) {
        return;
      }
      this.start(pending);
      this.chunks.length = 0;
      return;
    }

    this.append(this.decoder.decode(chunk, { stream: true }));
  }

  end(): void {
    if (!this.decoder) {
      this.start(Buffer.concat(this.chunks));
      this.chunks.length = 0;
    }
    const decoder = this.decoder;
    if (!decoder) {
      return;
    }
    const rest = decoder.decode();
    if (rest) {
      this.append(rest);
    }
  }

  private start(data: Buffer): void {
    this.decoder = new TextDecoder(selectOutputEncoding(data));
    if (data.length > 0) {
      this.append(this.decoder.decode(data, { stream: true }));
    }
  }
}

function selectOutputEncoding(data: Buffer): string {
  if (process.platform !== "win32" || data.length === 0) {
    return "utf-8";
  }

  const utf8 = new TextDecoder("utf-8").decode(data);
  const gb18030 = new TextDecoder("gb18030").decode(data);
  return scoreDecodedText(gb18030) + 1 < scoreDecodedText(utf8) ? "gb18030" : "utf-8";
}

function scoreDecodedText(text: string): number {
  let score = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\uFFFD") {
      score += 8;
    } else if (isMojibakeCodePoint(code)) {
      score += 2;
    } else if (isCjkCodePoint(code)) {
      score -= 0.2;
    }
  }
  return score;
}

function isMojibakeCodePoint(code: number): boolean {
  return (code >= 0x0370 && code <= 0x05FF) || (code >= 0x0100 && code <= 0x024F);
}

function isCjkCodePoint(code: number): boolean {
  return (code >= 0x3400 && code <= 0x9FFF) || (code >= 0xF900 && code <= 0xFAFF);
}

function platformNumber(platformName: PlatformName): number {
  switch (platformName) {
    case "android":
      return 1;
    case "linux":
      return 3;
    case "windows":
      return 4;
    case "html":
      return 7;
  }
}

export function buildKindForCommand(command: string): ProjectKind | undefined {
  if (command.endsWith("Android")) {
    return "android";
  }
  if (command.endsWith("Cxx")) {
    return "cxx";
  }
  if (command.endsWith("Html")) {
    return "html";
  }
  return undefined;
}
