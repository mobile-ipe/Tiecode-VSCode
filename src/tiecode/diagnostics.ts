import * as vscode from "vscode";
import { TiecodeCompilerService } from "./compilerService";
import { nativeListToArray, parseNativeResult, toVscodeRange, toVscodeUri } from "./interop";
import { isTiecodeDocument } from "./workspace";

export class TiecodeDiagnostics {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly service: TiecodeCompilerService,
    private readonly collection: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel
  ) {}

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.collection.dispose();
  }

  schedule(document: vscode.TextDocument): void {
    if (!isTiecodeDocument(document) || !this.isEnabled()) {
      return;
    }

    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.refreshDocument(document);
    }, 300));
  }

  async refreshDocument(document: vscode.TextDocument): Promise<void> {
    if (!isTiecodeDocument(document) || !this.isEnabled()) {
      return;
    }

    try {
      const result = await this.service.call(document, session => session.service.lintFile(document.uri.toString()));
      const parsed = parseNativeResult(result) as any;
      this.collection.set(document.uri, toDiagnostics(parsed?.diagnostics));
    } catch (error) {
      this.output.appendLine(`结绳诊断失败: ${String(error)}`);
    }
  }

  async refreshWorkspace(uri?: vscode.Uri): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const session = await this.service.getSession(uri);
    if (!session) {
      return;
    }

    try {
      const parsed = parseNativeResult(session.service.lintAll()) as any;
      const grouped = new Map<string, vscode.Diagnostic[]>();
      for (const item of nativeListToArray(parsed?.diagnostics)) {
        const diagnostic = toDiagnostic(item);
        const target = toVscodeUri((item as any)?.uri).toString();
        grouped.set(target, [...(grouped.get(target) ?? []), diagnostic]);
      }

      this.collection.clear();
      for (const [uri, diagnostics] of grouped) {
        this.collection.set(vscode.Uri.parse(uri), diagnostics);
      }
    } catch (error) {
      this.output.appendLine(`结绳工程诊断失败: ${String(error)}`);
    }
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration("tiecode").get<boolean>("diagnostics.enabled", true);
  }
}

function toDiagnostics(items: any): vscode.Diagnostic[] {
  return nativeListToArray(items).map(toDiagnostic);
}

function toDiagnostic(item: any): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    toVscodeRange(item?.range),
    String(item?.message ?? ""),
    toSeverity(Number(item?.level ?? 3))
  );
  diagnostic.source = "tiecode";
  if (item?.key) {
    diagnostic.code = String(item.key);
  }
  return diagnostic;
}

function toSeverity(level: number): vscode.DiagnosticSeverity {
  if (level >= 3) {
    return vscode.DiagnosticSeverity.Error;
  }
  if (level === 2) {
    return vscode.DiagnosticSeverity.Warning;
  }
  return vscode.DiagnosticSeverity.Information;
}
