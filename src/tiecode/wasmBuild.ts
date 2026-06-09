import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { createTiecodeOptions, loadTiecodeModule } from "./tiecRuntime";
import { BuildMode, ProjectInfo } from "./types";
import { getBundledStdlibsPath, isInsideRoot } from "./workspace";

interface MountedRoots {
  projectRoot: string;
  stdlibsRoot: string;
  projectMount: string;
  stdlibsMount: string;
}

export class TiecodeWasmBuildService {
  private modulePromise?: Promise<any>;
  private buildQueue: Promise<void> = Promise.resolve();
  private activeBuildLogs?: string[];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  compile(project: ProjectInfo, buildMode: BuildMode): Promise<void> {
    const build = this.buildQueue.catch(() => undefined).then(() => this.compileNow(project, buildMode));
    this.buildQueue = build.then(() => undefined, () => undefined);
    return build;
  }

  private async compileNow(project: ProjectInfo, buildMode: BuildMode): Promise<void> {
    const module = await this.loadModule();
    const tiec = module.tiec ?? module;
    const mounts = createMountedRoots(project);
    const buildLogs: string[] = [];
    this.activeBuildLogs = buildLogs;

    try {
      prepareHostOutputDirectory(project);
      mountProjectFileSystems(module, mounts);

      const options = createTiecodeOptions(tiec, project, {
        outputDir: mapHostPathToWasm(project.outputDir, mounts),
        lineMapPath: mapHostPathToWasm(project.lineMapPath, mounts),
        debug: buildMode !== "release",
        hardMode: true,
        ideMode: false,
        mapHostPath: hostPath => mapHostPathToWasm(hostPath, mounts)
      });
      const compiler = new tiec.Compiler(new tiec.Context(options));
      const sourceFiles = project.sourceFiles.map(filePath => mapHostPathToWasm(filePath, mounts));
      const result = compiler.compileFiles(sourceFiles);
      if (result !== true) {
        throw new Error(formatBuildFailure(buildLogs));
      }
    } finally {
      this.activeBuildLogs = undefined;
    }
  }

  private async loadModule(): Promise<any> {
    if (this.modulePromise) {
      return this.modulePromise;
    }

    this.modulePromise = loadTiecodeModule(this.context, {
      print: message => this.handleWasmMessage(message),
      printErr: message => this.handleWasmMessage(message)
    });
    return this.modulePromise;
  }

  private handleWasmMessage(message: string): void {
    const lines = String(message ?? "").split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
    for (const line of lines) {
      this.activeBuildLogs?.push(line);
      if (shouldShowBuildLog(line) || shouldTraceCompilerOutput()) {
        this.output.appendLine(line);
      }
    }
  }
}

function createMountedRoots(project: ProjectInfo): MountedRoots {
  return {
    projectRoot: path.resolve(project.rootPath),
    stdlibsRoot: path.resolve(getBundledStdlibsPath()),
    projectMount: "/project",
    stdlibsMount: "/stdlibs"
  };
}

function prepareHostOutputDirectory(project: ProjectInfo): void {
  const resolvedHostRoot = path.resolve(project.outputDir);
  const resolvedProjectRoot = path.resolve(project.rootPath);
  if (!isInsideRoot(resolvedHostRoot, resolvedProjectRoot)) {
    throw new Error(`构建输出目录必须在工程目录内: ${resolvedHostRoot}`);
  }

  fs.rmSync(resolvedHostRoot, { recursive: true, force: true });
  fs.mkdirSync(resolvedHostRoot, { recursive: true });
}

function mountProjectFileSystems(module: any, mounts: MountedRoots): void {
  const fsApi = module.FS;
  const nodeFs = fsApi.filesystems?.NODEFS;
  if (!nodeFs) {
    throw new Error("当前结绳 WASM 不支持 NODEFS，无法直接挂载 VS Code 文件系统。");
  }

  mountNodeFs(fsApi, nodeFs, mounts.projectMount, mounts.projectRoot);
  mountNodeFs(fsApi, nodeFs, mounts.stdlibsMount, mounts.stdlibsRoot);
}

function mountNodeFs(fsApi: any, nodeFs: any, mountPoint: string, hostRoot: string): void {
  if (!fs.existsSync(hostRoot) || !fs.statSync(hostRoot).isDirectory()) {
    throw new Error(`挂载目录不存在: ${hostRoot}`);
  }

  if (!fsApi.analyzePath(mountPoint).exists) {
    fsApi.mkdirTree(mountPoint);
  } else {
    try {
      fsApi.unmount(mountPoint);
    } catch {
      // 目录存在但不是挂载点时可以直接复用。
    }
  }
  fsApi.mount(nodeFs, { root: hostRoot }, mountPoint);
}

function mapHostPathToWasm(hostPath: string, mounts: MountedRoots): string {
  const resolved = path.resolve(hostPath);
  if (isInsideOrSame(resolved, mounts.projectRoot)) {
    return joinWasmPath(mounts.projectMount, path.relative(mounts.projectRoot, resolved));
  }
  if (isInsideOrSame(resolved, mounts.stdlibsRoot)) {
    return joinWasmPath(mounts.stdlibsMount, path.relative(mounts.stdlibsRoot, resolved));
  }
  throw new Error(`无法映射到 WASM 挂载目录: ${resolved}`);
}

function isInsideOrSame(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function joinWasmPath(root: string, relativePath: string): string {
  if (!relativePath) {
    return root;
  }
  return `${root}/${relativePath.replace(/\\/g, "/")}`;
}

function formatBuildFailure(logs: string[]): string {
  const errors = logs.filter(isCompilerErrorLine).slice(0, 3);
  if (errors.length > 0) {
    return `结绳 WASM 编译失败: ${errors.join(" | ")}`;
  }
  return "结绳 WASM 编译失败。";
}

function shouldShowBuildLog(line: string): boolean {
  return isCompilerErrorLine(line) || isCompilerWarningLine(line);
}

function isCompilerErrorLine(line: string): boolean {
  return /^\[ERROR\]/i.test(line) || /[:：]错误\(/.test(line);
}

function isCompilerWarningLine(line: string): boolean {
  return /^\[WARNING\]/i.test(line) || /[:：]警告\(/.test(line);
}

function shouldTraceCompilerOutput(): boolean {
  return vscode.workspace.getConfiguration("tiecode").get<boolean>("wasm.traceOutput", false);
}
