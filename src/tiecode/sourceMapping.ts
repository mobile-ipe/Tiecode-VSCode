import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ToolOutputLineHandler } from "./build";
import { LogcatCrashHandler } from "./logcatCrash";
import { ProjectInfo } from "./types";
import { createWasmOutputOptions } from "./wasmOutput";
import { loadTiecodeModule } from "./tiecRuntime";
import { getBundledStdlibsPath } from "./workspace";
import { mapHostPathToWasmMount, normalizeSlashes, resolveWasmOrHostPath } from "./wasmPaths";

export interface SourceMappedLocation {
  sourcePath: string;
  sourceLine: number;
  outputFile: string;
  outputLine: number;
}

export class SourceMappingService implements vscode.Disposable {
  private modulePromise?: Promise<any>;
  private readonly mappings = new Map<string, Promise<TiecodeSourceMapping | undefined>>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("tiecode-generated");

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  dispose(): void {
    this.diagnostics.dispose();
  }

  clearProject(project: ProjectInfo): void {
    this.mappings.delete(project.lineMapPath);
    this.diagnostics.clear();
  }

  async loadMapping(project: ProjectInfo): Promise<TiecodeSourceMapping | undefined> {
    if (!fs.existsSync(project.lineMapPath)) {
      return undefined;
    }

    const existing = this.mappings.get(project.lineMapPath);
    if (existing) {
      return existing;
    }

    const promise = this.createMapping(project).catch(error => {
      this.mappings.delete(project.lineMapPath);
      this.output.appendLine(`行号表加载失败: ${project.lineMapPath} ${String(error)}`);
      return undefined;
    });
    this.mappings.set(project.lineMapPath, promise);
    return promise;
  }

  async createJavacDiagnostics(project: ProjectInfo): Promise<ToolOutputLineHandler | undefined> {
    const mapping = await this.loadMapping(project);
    return mapping ? new JavacDiagnosticsHandler(mapping, this.diagnostics, this.output) : undefined;
  }

  async createLogcatDiagnostics(project: ProjectInfo): Promise<ToolOutputLineHandler | undefined> {
    const mapping = await this.loadMapping(project);
    return new LogcatCrashHandler(mapping, this.diagnostics, this.output);
  }

  private async createMapping(project: ProjectInfo): Promise<TiecodeSourceMapping | undefined> {
    const module = await this.loadModule();
    const tiec = module.tiec ?? module;
    if (typeof tiec.SourceMapping !== "function") {
      this.output.appendLine("当前结绳 WASM 未提供 SourceMapping。");
      return undefined;
    }
    const wasmPath = this.writeMappingToWasmFs(module, project.lineMapPath);
    return new TiecodeSourceMapping(new tiec.SourceMapping(wasmPath), project);
  }

  private writeMappingToWasmFs(module: any, mappingPath: string): string {
    const fsApi = module.FS;
    if (!fsApi?.writeFile) {
      return mappingPath;
    }

    const wasmDir = "/tiecode-vscode/mappings";
    if (typeof fsApi.analyzePath === "function" && !fsApi.analyzePath(wasmDir).exists) {
      fsApi.mkdirTree?.(wasmDir);
    }
    const wasmPath = `${wasmDir}/${hashText(mappingPath)}-${path.basename(mappingPath)}`;
    fsApi.writeFile(wasmPath, fs.readFileSync(mappingPath));
    return wasmPath;
  }

  private async loadModule(): Promise<any> {
    if (this.modulePromise) {
      return this.modulePromise;
    }

    this.modulePromise = this.importModule();
    return this.modulePromise;
  }

  private async importModule(): Promise<any> {
    return loadTiecodeModule(this.context, createWasmOutputOptions(this.output));
  }
}

export class TiecodeSourceMapping {
  constructor(
    private readonly nativeMapping: any,
    private readonly project: ProjectInfo
  ) {}

  mapOutputLine(outputPath: string, outputLine: number): SourceMappedLocation | undefined {
    if (!Number.isFinite(outputLine) || outputLine <= 0) {
      return undefined;
    }

    const candidates = createOutputPathCandidates(outputPath, this.project);
    for (const outputFile of candidates) {
      const sourceLine = this.nativeMapping.getSourceLine(outputFile, outputLine);
      const sourcePath = resolveMappedSourcePath(sourceLine?.path, this.project);
      const line = Number(sourceLine?.line ?? 0);
      if (sourcePath && line > 0) {
        return {
          sourcePath,
          sourceLine: line,
          outputFile,
          outputLine
        };
      }
    }
    return undefined;
  }

  getOriginalName(name: string): string | undefined {
    if (!name) {
      return undefined;
    }
    const original = this.nativeMapping.getOriginalName(name);
    return typeof original === "string" && original.length > 0 && original !== name ? original : undefined;
  }

  restoreQualifiedName(name: string): string {
    const whole = this.getOriginalName(name);
    if (whole) {
      return whole;
    }
    return name.split(".").map(part => this.getOriginalName(part) ?? part).join(".");
  }

  restoreText(text: string): string {
    return text.replace(/\b[A-Za-z_$][\w$]*\b/g, value => this.getOriginalName(value) ?? value);
  }
}

class JavacDiagnosticsHandler implements ToolOutputLineHandler {
  private readonly diagnostics = new Map<string, vscode.Diagnostic[]>();

  constructor(
    private readonly mapping: TiecodeSourceMapping,
    private readonly collection: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel
  ) {}

  handleLine(line: string): void {
    const diagnostic = parseJavacDiagnosticLine(line);
    if (!diagnostic) {
      return;
    }

    const mapped = this.mapping.mapOutputLine(diagnostic.outputPath, diagnostic.line);
    if (!mapped) {
      return;
    }

    const message = this.mapping.restoreText(diagnostic.message);
    const sourceUri = vscode.Uri.file(mapped.sourcePath);
    const range = new vscode.Range(
      Math.max(0, mapped.sourceLine - 1),
      0,
      Math.max(0, mapped.sourceLine - 1),
      Number.MAX_SAFE_INTEGER
    );
    const vscodeDiagnostic = new vscode.Diagnostic(range, message, diagnostic.severity);
    vscodeDiagnostic.source = "tiecode javac";

    const key = sourceUri.toString();
    this.diagnostics.set(key, [...(this.diagnostics.get(key) ?? []), vscodeDiagnostic]);
    this.output.appendLine(`=> 结绳源: ${mapped.sourcePath}:${mapped.sourceLine}: ${message}`);
  }

  flush(): void {
    for (const [uri, diagnostics] of this.diagnostics) {
      this.collection.set(vscode.Uri.parse(uri), diagnostics);
    }
  }
}

interface JavacDiagnosticLine {
  outputPath: string;
  line: number;
  severity: vscode.DiagnosticSeverity;
  message: string;
}

function parseJavacDiagnosticLine(line: string): JavacDiagnosticLine | undefined {
  const match = line.trim().match(/^(.+?\.java):(\d+):\s*([^:：]+)[:：]\s*(.*)$/);
  if (!match) {
    return undefined;
  }

  const outputPath = match[1] ?? "";
  const outputLine = Number(match[2]);
  if (!outputPath || !Number.isFinite(outputLine)) {
    return undefined;
  }

  return {
    outputPath,
    line: outputLine,
    severity: toDiagnosticSeverity(match[3] ?? ""),
    message: match[4] ?? line.trim()
  };
}

function toDiagnosticSeverity(kind: string): vscode.DiagnosticSeverity {
  const normalized = kind.toLocaleLowerCase();
  if (normalized.includes("warning") || normalized.includes("警告")) {
    return vscode.DiagnosticSeverity.Warning;
  }
  if (normalized.includes("note") || normalized.includes("注")) {
    return vscode.DiagnosticSeverity.Information;
  }
  return vscode.DiagnosticSeverity.Error;
}

function normalizeGeneratedFileName(outputPath: string): string {
  return normalizeSlashes(outputPath).split("/").pop() ?? outputPath;
}

function createOutputPathCandidates(outputPath: string, project: ProjectInfo): string[] {
  const candidates: string[] = [
    outputPath,
    normalizeSlashes(outputPath),
    normalizeGeneratedFileName(outputPath)
  ];

  for (const hostPath of createGeneratedHostPathCandidates(outputPath, project)) {
    const wasmPath = mapHostPathToWasmMount(hostPath, {
      mountPoint: "/project",
      hostRoot: project.rootPath
    });
    if (wasmPath) {
      candidates.push(wasmPath);
    }
  }

  return Array.from(new Set(candidates.filter(isString)));
}

function createGeneratedHostPathCandidates(outputPath: string, project: ProjectInfo): string[] {
  if (path.isAbsolute(outputPath)) {
    return [outputPath];
  }

  return [
    path.join(project.outputDir, outputPath),
    path.join(project.rootPath, outputPath)
  ];
}

function resolveMappedSourcePath(sourcePath: unknown, project: ProjectInfo): string {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    return "";
  }

  return resolveWasmOrHostPath(sourcePath, project.rootPath, [
    {
      mountPoint: "/project",
      hostRoot: project.rootPath
    },
    {
      mountPoint: "/stdlibs",
      hostRoot: getBundledStdlibsPath()
    }
  ]);
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
