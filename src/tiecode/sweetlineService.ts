import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import * as vscode from "vscode";
import { nativeListToArray } from "./interop";
import { ProjectInfo } from "./types";
import { getProjectDefines, getProjectInfo, isTiecodeRelatedDocument, isTlyDocument } from "./workspace";

type DynamicImport = (specifier: string) => Promise<any>;
export type TiecodeHighlightEngine = "hybrid" | "sweetline" | "compiler" | "textmate";

export interface SweetLineSemanticToken {
  range: vscode.Range;
  tokenType: string;
  tokenModifiers: string[];
}

interface SweetLineStyleDefinition {
  name: string;
  tokenType: string;
}

interface SweetLineEngineHost {
  key: string;
  module: any;
  engine: any;
  styleTokenTypes: Map<number, string>;
}

interface SweetLineDocumentCache {
  cacheKey: string;
  documentUri: string;
  version: number;
  syntaxName: string;
  host: SweetLineEngineHost;
  document: any;
  analyzer: any;
}

const SWEETLINE_STYLES: SweetLineStyleDefinition[] = [
  { name: "keyword", tokenType: "keyword" },
  { name: "string", tokenType: "string" },
  { name: "number", tokenType: "number" },
  { name: "comment", tokenType: "comment" },
  { name: "class", tokenType: "class" },
  { name: "method", tokenType: "method" },
  { name: "variable", tokenType: "variable" },
  { name: "punctuation", tokenType: "operator" },
  { name: "annotation", tokenType: "decorator" },
  { name: "preprocessor", tokenType: "macro" },
  { name: "macro", tokenType: "macro" },
  { name: "lifetime", tokenType: "typeParameter" },
  { name: "selector", tokenType: "property" },
  { name: "builtin", tokenType: "keyword" },
  { name: "url", tokenType: "string" },
  { name: "property", tokenType: "property" }
];

export class SweetLineService implements vscode.Disposable {
  private modulePromise?: Promise<any>;
  private readonly engines = new Map<string, Promise<SweetLineEngineHost>>();
  private readonly documents = new Map<string, SweetLineDocumentCache>();
  private lastErrorMessage?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  async provideSemanticTokens(
    document: vscode.TextDocument,
    range?: vscode.Range
  ): Promise<SweetLineSemanticToken[] | undefined> {
    if (!isTiecodeRelatedDocument(document) || getTiecodeHighlightEngine() === "compiler") {
      return undefined;
    }

    try {
      const host = await this.getEngine(document.uri);
      const syntaxName = this.getSyntaxName(document);
      const analyzer = this.getDocumentAnalyzer(host, document, syntaxName);
      const highlight = range
        ? this.analyzeRange(host.module, analyzer, document, range)
        : analyzer.analyze();
      this.lastErrorMessage = undefined;
      return this.convertHighlight(host, document, highlight, range);
    } catch (error) {
      this.reportError(error);
      return undefined;
    }
  }

  invalidate(uri?: vscode.Uri): void {
    const target = uri?.toString();
    for (const [cacheKey, cache] of this.documents) {
      if (!target || cache.documentUri === target) {
        this.disposeDocumentCache(cache);
        this.documents.delete(cacheKey);
      }
    }
  }

  dispose(): void {
    this.invalidate();
    this.engines.clear();
  }

  private async getEngine(uri: vscode.Uri): Promise<SweetLineEngineHost> {
    const project = getProjectInfo(uri);
    const key = this.createEngineKey(project);
    const existing = this.engines.get(key);
    if (existing) {
      return existing;
    }

    const enginePromise = this.createEngine(key, project).catch(error => {
      this.engines.delete(key);
      throw error;
    });
    this.engines.set(key, enginePromise);
    return enginePromise;
  }

  private async createEngine(key: string, project: ProjectInfo | undefined): Promise<SweetLineEngineHost> {
    const module = await this.loadModule();
    const config = new module.HighlightConfig();
    config.showIndex = false;
    config.inlineStyle = false;
    config.tabSize = this.getTabSize();

    const engine = new module.HighlightEngine(config);
    const styleTokenTypes = new Map<number, string>();
    for (let index = 0; index < SWEETLINE_STYLES.length; index += 1) {
      const styleId = index + 1;
      const style = SWEETLINE_STYLES[index];
      engine.registerStyleName(style.name, styleId);
      styleTokenTypes.set(styleId, style.tokenType);
    }

    for (const macro of this.getMacros(project)) {
      engine.defineMacro(macro);
    }
    this.compileSyntaxAssets(engine);

    return { key, module, engine, styleTokenTypes };
  }

  private async loadModule(): Promise<any> {
    if (this.modulePromise) {
      return this.modulePromise;
    }

    this.modulePromise = this.importModule();
    return this.modulePromise;
  }

  private async importModule(): Promise<any> {
    const wasmDir = path.join(this.context.extensionPath, "assets", "sweetline", "wasm");
    const modulePath = path.join(wasmDir, "sweetline.mjs");
    if (!fs.existsSync(modulePath)) {
      throw new Error(`找不到 SweetLine WASM 模块: ${modulePath}`);
    }

    const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;
    const imported = await dynamicImport(pathToFileURL(modulePath).href);
    const factory = imported.default ?? imported;
    return factory({
      locateFile: (fileName: string) => path.join(wasmDir, fileName),
      print: (message: string) => this.output.appendLine(String(message ?? "")),
      printErr: (message: string) => this.output.appendLine(String(message ?? ""))
    });
  }

  private compileSyntaxAssets(engine: any): void {
    const syntaxDir = path.join(this.context.extensionPath, "assets", "sweetline", "syntaxes");
    if (!fs.existsSync(syntaxDir)) {
      throw new Error(`找不到 SweetLine 语法目录: ${syntaxDir}`);
    }

    const pending = fs.readdirSync(syntaxDir)
      .filter(fileName => fileName.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
    let lastError: unknown;

    while (pending.length > 0) {
      const before = pending.length;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const fileName = pending[index];
        try {
          const content = fs.readFileSync(path.join(syntaxDir, fileName), "utf8");
          engine.compileSyntaxFromJson(content);
          pending.splice(index, 1);
        } catch (error) {
          lastError = error;
        }
      }

      if (pending.length === before) {
        throw new Error(`SweetLine 语法编译失败: ${pending.join(", ")} ${String(lastError ?? "")}`);
      }
    }
  }

  private getDocumentAnalyzer(
    host: SweetLineEngineHost,
    document: vscode.TextDocument,
    syntaxName: string
  ): any {
    const documentUri = this.createSweetLineDocumentUri(document, syntaxName);
    const cacheKey = `${host.key}\u0000${document.uri.toString()}`;
    const existing = this.documents.get(cacheKey);
    if (existing && existing.version === document.version && existing.syntaxName === syntaxName) {
      return existing.analyzer;
    }

    if (existing) {
      this.disposeDocumentCache(existing);
      this.documents.delete(cacheKey);
    }

    const sweetLineDocument = new host.module.Document(documentUri, document.getText());
    const analyzer = host.engine.loadDocument(sweetLineDocument);
    if (!analyzer) {
      optionalDelete(sweetLineDocument);
      throw new Error(`SweetLine 无法创建 ${syntaxName} 文档分析器。`);
    }

    const cache: SweetLineDocumentCache = {
      cacheKey,
      documentUri: document.uri.toString(),
      version: document.version,
      syntaxName,
      host,
      document: sweetLineDocument,
      analyzer
    };
    this.documents.set(cacheKey, cache);
    return analyzer;
  }

  private analyzeRange(module: any, analyzer: any, document: vscode.TextDocument, range: vscode.Range): any {
    const lineRange = new module.LineRange();
    lineRange.startLine = Math.max(0, Math.min(range.start.line, document.lineCount - 1));
    const endLine = Math.max(lineRange.startLine, Math.min(range.end.line, document.lineCount - 1));
    lineRange.lineCount = endLine - lineRange.startLine + 1;
    return analyzer.analyzeLineRange(lineRange);
  }

  private convertHighlight(
    host: SweetLineEngineHost,
    document: vscode.TextDocument,
    highlight: any,
    requestedRange?: vscode.Range
  ): SweetLineSemanticToken[] {
    const tokens: SweetLineSemanticToken[] = [];
    const lines = nativeListToArray(highlight?.lines);
    const startLine = Number(highlight?.startLine ?? 0);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] as any;
      const fallbackLine = startLine + lineIndex;
      for (const span of nativeListToArray<any>(line?.spans)) {
        const tokenType = this.getTokenType(host, Number(span?.styleId ?? 0));
        const range = this.toVscodeRange(document, span?.range, fallbackLine);
        if (!tokenType || !range || (requestedRange && !range.intersection(requestedRange))) {
          continue;
        }
        tokens.push({ range, tokenType, tokenModifiers: [] });
      }
    }

    return tokens;
  }

  private getTokenType(host: SweetLineEngineHost, styleId: number): string | undefined {
    const registered = host.styleTokenTypes.get(styleId);
    if (registered) {
      return registered;
    }

    try {
      const styleName = host.engine.getStyleName(styleId);
      return SWEETLINE_STYLES.find(style => style.name === styleName)?.tokenType;
    } catch {
      return undefined;
    }
  }

  private toVscodeRange(document: vscode.TextDocument, value: any, fallbackLine: number): vscode.Range | undefined {
    const start = value?.start ?? {};
    const end = value?.end ?? {};
    const startLine = clampLine(Number(start.line ?? fallbackLine), document);
    const endLine = clampLine(Number(end.line ?? startLine), document);
    const startCharacter = clampCharacter(Number(start.column ?? 0), document, startLine);
    const endCharacter = clampCharacter(Number(end.column ?? startCharacter), document, endLine);
    const range = new vscode.Range(startLine, startCharacter, endLine, endCharacter);
    return range.isEmpty ? undefined : range;
  }

  private getSyntaxName(document: vscode.TextDocument): string {
    return isTlyDocument(document) ? "tly" : "tiecode";
  }

  private createSweetLineDocumentUri(document: vscode.TextDocument, syntaxName: string): string {
    const raw = document.uri.toString();
    if (/\.(t|tly)(?:$|[?#])/i.test(raw)) {
      return raw;
    }
    return `${raw}.${syntaxName === "tly" ? "tly" : "t"}`;
  }

  private createEngineKey(project: ProjectInfo | undefined): string {
    return `${this.getTabSize()}:${this.getMacros(project).join("+") || "none"}`;
  }

  private getMacros(project: ProjectInfo | undefined): string[] {
    const macros: string[] = [];
    const platform = project?.platformName;
    if (platform === "android") {
      macros.push("ANDROID");
    } else if (platform === "windows" || platform === "linux") {
      macros.push("WINDOWS");
    } else if (platform === "html") {
      macros.push("HTML");
    } else {
      macros.push("ANDROID");
    }

    if (project) {
      for (const [name, value] of Object.entries(getProjectDefines(project.config))) {
        if (value !== false && value !== null) {
          macros.push(name);
        }
      }
    }
    return Array.from(new Set(macros));
  }

  private getTabSize(): number {
    const value = vscode.workspace.getConfiguration("editor").get<number>("tabSize", 4);
    return Number.isFinite(value) && value > 0 ? value : 4;
  }

  private disposeDocumentCache(cache: SweetLineDocumentCache): void {
    try {
      cache.host.engine.removeDocument(cache.document.getUri());
    } catch {
      // SweetLine 可能已经释放了托管文档。
    }
    optionalDelete(cache.analyzer);
    optionalDelete(cache.document);
  }

  private reportError(error: unknown): void {
    const message = String(error);
    if (message === this.lastErrorMessage) {
      return;
    }

    this.lastErrorMessage = message;
    this.output.appendLine(`SweetLine 高亮失败: ${message}`);
  }
}

export function getTiecodeHighlightEngine(): TiecodeHighlightEngine {
  const configured = vscode.workspace.getConfiguration("tiecode").get<string>("highlight.engine", "hybrid");
  if (configured === "sweetline" || configured === "compiler" || configured === "textmate") {
    return configured;
  }
  return "hybrid";
}

function clampLine(line: number, document: vscode.TextDocument): number {
  return Math.max(0, Math.min(line, document.lineCount - 1));
}

function clampCharacter(character: number, document: vscode.TextDocument, line: number): number {
  return Math.max(0, Math.min(character, document.lineAt(line).text.length));
}

function optionalDelete(value: any): void {
  try {
    if (typeof value?.delete === "function") {
      value.delete();
    }
  } catch {
  }
}
