import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { TextDecoder } from "util";
import * as vscode from "vscode";
import { SourceMappingService } from "./sourceMapping";
import { ToolchainService } from "./toolchain";
import { BuildMode, BuildRequest, ProjectInfo, TARGET_PLATFORM_NUMBER } from "./types";
import { TiecodeWasmBuildService } from "./wasmBuild";
import { ensureDirectory, getProjectBuildMode, getProjectInfo, resolveMaybeRelative } from "./workspace";

export interface ToolOutputLineHandler {
  handleLine(line: string): boolean | void;
  flush?(): void;
}

export interface BuildProjectOptions {
  buildMode?: BuildMode;
  gradleTask?: string;
  runGradle?: boolean;
  runCmake?: boolean;
  env?: NodeJS.ProcessEnv;
  toolchain?: ToolchainService;
  sourceMapping?: SourceMappingService;
  compiler: TiecodeWasmBuildService;
}

export function registerBuildCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  toolchain: ToolchainService,
  sourceMapping: SourceMappingService,
  compiler: TiecodeWasmBuildService
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tiecode.buildAndroid", () => buildProject({ kind: "android", platformName: "android" }, output, toolchain, sourceMapping, compiler)),
    vscode.commands.registerCommand("tiecode.buildCxx", () => buildProject({ kind: "cxx" }, output, toolchain, sourceMapping, compiler)),
    vscode.commands.registerCommand("tiecode.buildHtml", () => buildProject({ kind: "html", platformName: "html" }, output, toolchain, sourceMapping, compiler))
  );
}

export async function buildProject(
  request: BuildRequest,
  output: vscode.OutputChannel,
  toolchain: ToolchainService,
  sourceMapping: SourceMappingService,
  compiler: TiecodeWasmBuildService
): Promise<void> {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "正在构建结绳工程",
    cancellable: false
  }, async () => {
    try {
      const project = await buildTiecodeProject(request, output, { toolchain, sourceMapping, compiler });
      void vscode.window.showInformationMessage(`结绳构建完成: ${project.outputDir}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`结绳构建失败: ${String(error instanceof Error ? error.message : error)}`);
    }
  });
}

export async function buildTiecodeProject(
  request: BuildRequest,
  output: vscode.OutputChannel,
  options: BuildProjectOptions
): Promise<ProjectInfo> {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const project = getProjectInfo(uri, request.kind);
  if (!project) {
    throw new Error("没有打开结绳工作区。");
  }

  const buildProjectInfo = { ...project, platformName: request.platformName ?? project.platformName };
  buildProjectInfo.platformNumber = TARGET_PLATFORM_NUMBER[buildProjectInfo.platformName];

  if (buildProjectInfo.sourceFiles.length === 0) {
    throw new Error(`未找到结绳源文件: ${buildProjectInfo.rootPath}`);
  }

  const buildMode = options.buildMode ?? getProjectBuildMode(buildProjectInfo.config);
  const buildOptions = await prepareBuildOptions(buildProjectInfo, { ...options, buildMode });
  options.sourceMapping?.clearProject(buildProjectInfo);
  output.show(true);
  output.appendLine(`源文件数量: ${buildProjectInfo.sourceFiles.length}`);
  output.appendLine("> tiec.wasm compile");

  await options.compiler.compile(buildProjectInfo, buildMode);
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
  const runGradle = options.runGradle ?? true;
  if (!runGradle) {
    return;
  }

  const gradleRoot = project.outputDir;
  if (!fs.existsSync(path.join(gradleRoot, "settings.gradle")) && !fs.existsSync(path.join(gradleRoot, "build.gradle"))) {
    throw new Error(`未找到 Gradle 工程: ${gradleRoot}`);
  }

  const task = options.gradleTask ?? (options.buildMode === "release" ? "assembleRelease" : "assembleDebug");
  const javacDiagnostics = await options.sourceMapping?.createJavacDiagnostics(project);
  const wrapper = process.platform === "win32"
    ? path.join(gradleRoot, "gradlew.bat")
    : path.join(gradleRoot, "gradlew");
  try {
    if (fs.existsSync(wrapper)) {
      await runGradleWrapper(wrapper, [task], gradleRoot, output, options.env, javacDiagnostics);
      return;
    }

    await runTool("gradle", [task], gradleRoot, output, process.platform === "win32", options.env, javacDiagnostics);
  } finally {
    javacDiagnostics?.flush?.();
  }
}

async function runCxxCMakeBuild(project: ProjectInfo, output: vscode.OutputChannel, options: BuildProjectOptions): Promise<void> {
  const cxxConfig = project.config.cxx ?? {};
  const runCmake = options.runCmake ?? cxxConfig.runCmake ?? true;
  if (!runCmake) {
    return;
  }

  const sourceDir = resolveCMakeSourceDirectory(project);
  if (!sourceDir) {
    throw new Error(`未找到 CMakeLists.txt: ${path.join(project.outputDir, "src")} 或 ${project.rootPath}`);
  }

  const cmakeCommand = cxxConfig.cmakeCommand ?? "cmake";
  const generator = cxxConfig.cmakeGenerator;
  const buildType = cxxConfig.cmakeBuildType ?? (options.buildMode === "release" ? "Release" : "Debug");
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

export function runTool(
  command: string,
  args: string[],
  cwd: string,
  output: vscode.OutputChannel,
  shell = process.platform === "win32",
  env?: NodeJS.ProcessEnv,
  lineHandler?: ToolOutputLineHandler
): Promise<void> {
  output.appendLine(`> ${quoteArg(command)} ${args.map(quoteArg).join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, shell, env });
    const stdout = new ProcessOutputDecoder(text => output.append(text), lineHandler);
    const stderr = new ProcessOutputDecoder(text => output.append(text), lineHandler);
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

function runGradleWrapper(
  wrapper: string,
  args: string[],
  cwd: string,
  output: vscode.OutputChannel,
  env?: NodeJS.ProcessEnv,
  lineHandler?: ToolOutputLineHandler
): Promise<void> {
  if (process.platform === "win32") {
    return runTool(getWindowsCommandProcessor(), ["/d", "/c", "chcp", "65001", ">nul", "&&", "call", wrapper, ...args], cwd, output, false, env, lineHandler);
  }
  return runTool("sh", [wrapper, ...args], cwd, output, false, env, lineHandler);
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
  const cxxConfig = project.config.cxx ?? {};
  return resolveMaybeRelative(
    project.rootPath,
    cxxConfig.cmakeBuildDirectory ?? "${workspaceFolder}\\build\\cmake"
  );
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, "\\\"")}"` : value;
}

function getWindowsCommandProcessor(): string {
  return process.env.ComSpec
    ?? (process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "cmd.exe") : "C:\\Windows\\System32\\cmd.exe");
}

class ProcessOutputDecoder {
  private readonly chunks: Buffer[] = [];
  private decoder?: TextDecoder;
  private readonly lines?: ProcessLineEmitter;

  constructor(
    private readonly append: (text: string) => void,
    lineHandler?: ToolOutputLineHandler
  ) {
    this.lines = lineHandler ? new ProcessLineEmitter(lineHandler) : undefined;
  }

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

    this.appendDecoded(this.decoder.decode(chunk, { stream: true }));
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
      this.appendDecoded(rest);
    }
    this.lines?.end();
  }

  private start(data: Buffer): void {
    this.decoder = new TextDecoder(selectOutputEncoding(data));
    if (data.length > 0) {
      this.appendDecoded(this.decoder.decode(data, { stream: true }));
    }
  }

  private appendDecoded(text: string): void {
    this.append(text);
    this.lines?.write(text);
  }
}

class ProcessLineEmitter {
  private pending = "";

  constructor(private readonly handler: ToolOutputLineHandler) {}

  write(text: string): void {
    this.pending += text;
    let newline = this.pending.search(/\r?\n/);
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + (this.pending[newline] === "\r" && this.pending[newline + 1] === "\n" ? 2 : 1));
      this.emit(line);
      newline = this.pending.search(/\r?\n/);
    }
  }

  end(): void {
    if (this.pending.length > 0) {
      this.emit(this.pending.replace(/\r$/, ""));
      this.pending = "";
    }
  }

  private emit(line: string): void {
    try {
      this.handler.handleLine(line);
    } catch {
      // 输出处理不能影响实际构建进程。
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
