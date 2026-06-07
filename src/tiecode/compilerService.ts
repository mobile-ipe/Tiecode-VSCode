import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import * as vscode from "vscode";
import { NativeSession, ProjectInfo, ProjectKind } from "./types";
import { getProjectInfo, isTiecodeDocument } from "./workspace";

type DynamicImport = (specifier: string) => Promise<any>;

export class TiecodeCompilerService {
  private modulePromise?: Promise<any>;
  private readonly sessions = new Map<string, Promise<NativeSession>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  async reload(uri?: vscode.Uri): Promise<void> {
    if (uri) {
      const project = getProjectInfo(uri);
      if (project) {
        this.sessions.delete(project.rootPath);
        await this.getSessionForProject(project);
      }
      return;
    }

    this.sessions.clear();
    const project = getProjectInfo();
    if (project) {
      await this.getSessionForProject(project);
    }
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
      session.service.didCreateSource(uri.toString(), initialText);
    }
  }

  async notifyDelete(uri: vscode.Uri): Promise<void> {
    const session = await this.getSession(uri);
    if (session?.service?.didDeleteSource) {
      session.service.didDeleteSource(uri.toString());
    }
  }

  async notifyRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const session = await this.getSession(newUri);
    if (session?.service?.didRenameSource) {
      session.service.didRenameSource(oldUri.toString(), newUri.toString());
    }
  }

  createCursorParams(tiec: any, document: vscode.TextDocument, position: vscode.Position): any {
    const params = new tiec.CursorParams();
    params.uri = tiec.Uri.fromString(document.uri.toString());
    params.position = this.createPosition(tiec, position);
    params.lineText = document.lineAt(position.line).text;
    return params;
  }

  createCompletionParams(tiec: any, document: vscode.TextDocument, position: vscode.Position, triggerChar?: string): any {
    const params = new tiec.CompletionParams();
    params.uri = tiec.Uri.fromString(document.uri.toString());
    params.position = this.createPosition(tiec, position);
    params.lineText = document.lineAt(position.line).text;
    params.partial = getPartial(document, position);
    params.triggerChar = triggerChar ?? "";
    return params;
  }

  createSignatureHelpParams(tiec: any, document: vscode.TextDocument, position: vscode.Position, triggerChar?: string): any {
    const params = new tiec.SignatureHelpParams();
    params.uri = tiec.Uri.fromString(document.uri.toString());
    params.position = this.createPosition(tiec, position);
    params.lineText = document.lineAt(position.line).text;
    params.triggerChar = triggerChar ?? "";
    return params;
  }

  private async getSessionForProject(project: ProjectInfo): Promise<NativeSession> {
    const existing = this.sessions.get(project.rootPath);
    if (existing) {
      return existing;
    }

    const sessionPromise = this.createSession(project);
    this.sessions.set(project.rootPath, sessionPromise);
    return sessionPromise;
  }

  private async createSession(project: ProjectInfo): Promise<NativeSession> {
    const module = await this.loadModule();
    const tiec = module.tiec ?? module;
    const options = this.createOptions(tiec, project);
    const context = new tiec.Context(options);
    const service = new tiec.IDEService(context);

    if (project.sourceFiles.length > 0) {
      service.compileFiles(project.sourceFiles);
    }

    const session: NativeSession = { project, module, tiec, service };
    for (const document of vscode.workspace.textDocuments) {
      if (isTiecodeDocument(document)) {
        this.syncDocument(session, document);
      }
    }
    return session;
  }

  private createOptions(tiec: any, project: ProjectInfo): any {
    const options = new tiec.Options();
    options.sourceVersion = enumMember(tiec.SourceVersion, sourceVersionKey(project.sourceVersion), project.sourceVersion);
    options.packageName = project.packageName;
    options.outputDir = project.outputDir;
    options.lineMapPath = project.lineMapPath;
    options.debug = true;
    options.hardMode = false;
    options.enableTopLevelStmt = true;
    options.friendlyName = enumMember(tiec.FriendlyNameKind, "RANDOM", 0);
    options.ideMode = true;
    options.profile = enumMember(tiec.BuildProfile, "STANDARD", 0);
    options.optimizeLevel = 0;
    options.logLevel = enumMember(tiec.LogLevel, "WARNING", 2);
    options.platform = enumMember(tiec.TargetPlatform, project.platformName.toUpperCase(), project.platformNumber);

    if (typeof options.addSearchPrefix === "function") {
      for (const sourceRoot of project.sourceRoots) {
        options.addSearchPrefix("source", sourceRoot);
      }
    }

    if (project.kind === "android" && typeof options.setAndroidOptions === "function") {
      this.applyAndroidOptions(tiec, project, options);
    }

    return options;
  }

  private applyAndroidOptions(tiec: any, project: ProjectInfo, options: any): void {
    try {
      const androidConfig = project.config.android ?? {};
      const appConfig = new tiec.AndroidAppConfig();
      appConfig.appName = androidConfig.appName ?? project.config.name ?? "我的应用";
      appConfig.appIcon = androidConfig.iconPath ?? "";
      appConfig.minSdk = androidConfig.minSdk ?? 21;
      appConfig.targetSdk = androidConfig.targetSdk ?? 28;
      appConfig.versionCode = androidConfig.versionCode ?? 1;
      appConfig.versionName = androidConfig.versionName ?? "1.0";

      const androidOptions = new tiec.AndroidOptions();
      androidOptions.appConfig = appConfig;
      androidOptions.gradle = androidConfig.gradle ?? vscode.workspace.getConfiguration("tiecode").get<boolean>("android.gradle") ?? true;
      androidOptions.foundationLibPath = androidConfig.foundationLibPath ?? path.dirname(project.stdlibSourceRoot ?? "");
      options.setAndroidOptions(androidOptions);
    } catch (error) {
      this.output.appendLine(`Android 编译选项初始化失败: ${String(error)}`);
    }
  }

  private syncDocument(session: NativeSession, document: vscode.TextDocument): void {
    try {
      session.service.didChangeSource(document.uri.toString(), document.getText());
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

    const wasmDir = path.join(this.context.extensionPath, "assets", "wasm");
    const modulePath = path.join(wasmDir, "libtiec.mjs");
    if (!fs.existsSync(modulePath)) {
      throw new Error(`找不到结绳 WASM 模块: ${modulePath}`);
    }

    const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;
    const imported = await dynamicImport(pathToFileURL(modulePath).href);
    const factory = imported.default ?? imported;
    return factory({
      locateFile: (fileName: string) => path.join(wasmDir, fileName),
      print: (message: string) => this.output.appendLine(message),
      printErr: (message: string) => this.output.appendLine(message)
    });
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration("tiecode").get<boolean>("languageService.enabled", true);
  }
}

function enumMember(enumObject: any, key: string, fallback: number): unknown {
  return enumObject?.[key] ?? fallback;
}

function sourceVersionKey(sourceVersion: number): string {
  if (sourceVersion === 40) {
    return "VERSION_4_0";
  }
  if (sourceVersion === 46) {
    return "VERSION_4_6";
  }
  return "VERSION_4_7";
}

function getPartial(document: vscode.TextDocument, position: vscode.Position): string {
  const beforeCursor = document.lineAt(position.line).text.slice(0, position.character);
  return beforeCursor.match(/[\p{L}\p{N}_@]+$/u)?.[0] ?? "";
}
