import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { NativeSession, ProjectInfo, ProjectKind } from "./types";
import { toTiecodeRange } from "./interop";
import { createWasmOutputOptions } from "./wasmOutput";
import { createTiecodeOptions, loadTiecodeModule } from "./tiecRuntime";
import { getProjectInfo, isTiecodeDocument } from "./workspace";

export class TiecodeCompilerService {
  private modulePromise?: Promise<any>;
  private readonly sessions = new Map<string, Promise<NativeSession>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  async reload(uri?: vscode.Uri): Promise<NativeSession | undefined> {
    if (uri) {
      const project = getProjectInfo(uri);
      if (project) {
        this.sessions.delete(project.rootPath);
        return this.getSessionForProject(project);
      }
      return undefined;
    }

    this.sessions.clear();
    const project = getProjectInfo();
    if (project) {
      return this.getSessionForProject(project);
    }
    return undefined;
  }

  async call<T>(document: vscode.TextDocument, callback: (session: NativeSession) => T | Promise<T>): Promise<T | undefined> {
    if (!this.isEnabled() || !isTiecodeDocument(document)) {
      return undefined;
    }

    const session = await this.getSession(document.uri);
    if (!session) {
      return undefined;
    }

    this.syncDocument(session, document);
    return callback(session);
  }

  async getSession(uri?: vscode.Uri, overrideKind?: ProjectKind): Promise<NativeSession | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    const project = getProjectInfo(uri, overrideKind);
    if (!project) {
      return undefined;
    }

    return this.getSessionForProject(project);
  }

  async notifyCreate(uri: vscode.Uri, initialText = ""): Promise<void> {
    const session = await this.getSession(uri);
    if (session?.service?.didCreateSource) {
      session.service.didCreateSource(this.createUri(session.tiec, uri), initialText);
    }
  }

  async notifyChange(uri: vscode.Uri, newText: string): Promise<void> {
    const session = await this.getSession(uri);
    if (session?.service?.didChangeSource) {
      session.service.didChangeSource(this.createUri(session.tiec, uri), newText);
    }
  }

  async notifyDelete(uri: vscode.Uri): Promise<void> {
    const session = await this.getSession(uri);
    if (session?.service?.didDeleteSource) {
      session.service.didDeleteSource(this.createUri(session.tiec, uri));
    }
  }

  async notifyRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const session = await this.getSession(newUri);
    if (session?.service?.didRenameSource) {
      session.service.didRenameSource(this.createUri(session.tiec, oldUri), this.createUri(session.tiec, newUri));
    }
  }

  async cancel(uri?: vscode.Uri): Promise<void> {
    const session = await this.getSession(uri);
    session?.service?.cancel?.();
  }

  async syncTextDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
    const document = event.document;
    if (!this.isEnabled() || !isTiecodeDocument(document)) {
      return;
    }

    const session = await this.getSession(document.uri);
    if (!session) {
      return;
    }

    if (event.contentChanges.length === 0 || typeof session.service.didChangeSourceIncremental !== "function") {
      this.syncDocument(session, document);
      return;
    }

    try {
      const uri = this.createUri(session.tiec, document.uri);
      for (const change of event.contentChanges) {
        const nativeChange = new session.tiec.TextChange();
        nativeChange.range = toTiecodeRange(session.tiec, change.range);
        nativeChange.newText = change.text;
        session.service.didChangeSourceIncremental(uri, nativeChange);
      }
    } catch (error) {
      this.output.appendLine(`增量同步结绳文档失败，改用全量同步: ${document.uri.toString()} ${String(error)}`);
      this.syncDocument(session, document);
    }
  }

  createCursorParams(tiec: any, document: vscode.TextDocument, position: vscode.Position): any {
    const params = new tiec.CompletionParams();
    params.uri = this.createUri(tiec, document.uri);
    params.position = this.createPosition(tiec, position);
    params.lineText = document.lineAt(position.line).text;
    return params;
  }

  createCompletionParams(tiec: any, document: vscode.TextDocument, position: vscode.Position, triggerChar?: string): any {
    const params = new tiec.CompletionParams();
    params.uri = this.createUri(tiec, document.uri);
    params.position = this.createPosition(tiec, position);
    params.lineText = document.lineAt(position.line).text;
    params.partial = getPartial(document, position);
    params.triggerChar = triggerChar ?? "";
    return params;
  }

  createSignatureHelpParams(tiec: any, document: vscode.TextDocument, position: vscode.Position, triggerChar?: string): any {
    const params = new tiec.SignatureHelpParams();
    params.uri = this.createUri(tiec, document.uri);
    params.position = this.createPosition(tiec, position);
    params.lineText = document.lineAt(position.line).text;
    params.triggerChar = triggerChar ?? "";
    return params;
  }

  createUri(tiec: any, uri: vscode.Uri): any {
    return tiec.Uri.fromString(this.createUriString(uri));
  }

  createUriString(uri: vscode.Uri): string {
    if (uri.scheme === "file") {
      return `file://${toCompilerFileUriPath(uri.fsPath)}`;
    }
    return uri.toString();
  }

  private async getSessionForProject(project: ProjectInfo): Promise<NativeSession> {
    const existing = this.sessions.get(project.rootPath);
    if (existing) {
      return existing;
    }

    const sessionPromise = this.createSession(project).catch(error => {
      this.sessions.delete(project.rootPath);
      throw error;
    });
    this.sessions.set(project.rootPath, sessionPromise);
    return sessionPromise;
  }

  private async createSession(project: ProjectInfo): Promise<NativeSession> {
    const module = await this.loadModule();
    const tiec = module.tiec ?? module;
    const options = this.createOptions(tiec, project);
    const context = new tiec.Context(options);
    const service = new tiec.IDEService(context);

    this.compileProjectSources(tiec, service, project);

    const session: NativeSession = { project, module, tiec, service };
    for (const document of vscode.workspace.textDocuments) {
      if (isTiecodeDocument(document)) {
        this.syncDocument(session, document);
      }
    }
    return session;
  }

  private createOptions(tiec: any, project: ProjectInfo): any {
    return createTiecodeOptions(tiec, project, {
      outputDir: project.outputDir,
      lineMapPath: project.lineMapPath,
      debug: true,
      hardMode: false,
      ideMode: true
    });
  }

  private compileProjectSources(tiec: any, service: any, project: ProjectInfo): void {
    if (project.sourceFiles.length === 0) {
      return;
    }

    if (typeof tiec.SourceList !== "function" || typeof tiec.defineSource !== "function" || typeof service.compileSources !== "function") {
      service.compileFiles(project.sourceFiles);
      return;
    }

    const sources = new tiec.SourceList();
    for (const filePath of project.sourceFiles) {
      const uri = vscode.Uri.file(filePath);
      sources.add(tiec.defineSource(this.createUriString(uri), readProjectSourceText(filePath)));
    }
    service.compileSources(sources);
  }

  private syncDocument(session: NativeSession, document: vscode.TextDocument): void {
    try {
      session.service.didChangeSource(this.createUri(session.tiec, document.uri), document.getText());
    } catch (error) {
      this.output.appendLine(`同步结绳文档失败: ${document.uri.toString()} ${String(error)}`);
    }
  }

  private createPosition(tiec: any, position: vscode.Position): any {
    const nativePosition = new tiec.Position();
    nativePosition.line = position.line;
    nativePosition.column = position.character;
    return nativePosition;
  }

  private async loadModule(): Promise<any> {
    if (this.modulePromise) {
      return this.modulePromise;
    }

    this.modulePromise = this.importModule();
    return this.modulePromise;
  }

  private async importModule(): Promise<any> {
    const settings = vscode.workspace.getConfiguration("tiecode");
    if (!settings.get<boolean>("languageService.enabled", true)) {
      throw new Error("结绳语言服务已被配置关闭。");
    }

    return loadTiecodeModule(this.context, createWasmOutputOptions(this.output));
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration("tiecode").get<boolean>("languageService.enabled", true);
  }
}

function getPartial(document: vscode.TextDocument, position: vscode.Position): string {
  const beforeCursor = document.lineAt(position.line).text.slice(0, position.character);
  return beforeCursor.match(/[\p{L}\p{N}_@]+$/u)?.[0] ?? "";
}

function toCompilerFileUriPath(filePath: string): string {
  let normalized = path.normalize(filePath).replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = `/${normalized}`;
  }
  return normalized;
}

function readProjectSourceText(filePath: string): string {
  const openDocument = vscode.workspace.textDocuments.find(document =>
    document.uri.scheme === "file" && sameFilePath(document.uri.fsPath, filePath)
  );
  if (openDocument) {
    return openDocument.getText();
  }

  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function sameFilePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}
