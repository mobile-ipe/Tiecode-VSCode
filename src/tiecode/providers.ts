import * as vscode from "vscode";
import { TiecodeCompilerService } from "./compilerService";
import {
  nativeListToArray,
  parseNativeResult,
  textEditsToWorkspaceEdit,
  toVscodeLocation,
  toVscodeRange,
  toVscodeTextEdits,
  toVscodeUri,
  toWorkspaceEdit
} from "./interop";

const tiecodeSelector: vscode.DocumentSelector = [{ language: "tiecode", scheme: "file" }];
const semanticLegend = new vscode.SemanticTokensLegend(
  ["class", "variable", "method", "function", "property", "event", "decorator", "typeParameter"],
  ["static", "deprecated"]
);

export function registerTiecodeProviders(context: vscode.ExtensionContext, service: TiecodeCompilerService): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(tiecodeSelector, new TiecodeCompletionProvider(service), ".", ":", "@", "(", "\""),
    vscode.languages.registerHoverProvider(tiecodeSelector, new TiecodeHoverProvider(service)),
    vscode.languages.registerDocumentFormattingEditProvider(tiecodeSelector, new TiecodeFormattingProvider(service)),
    vscode.languages.registerDefinitionProvider(tiecodeSelector, new TiecodeDefinitionProvider(service)),
    vscode.languages.registerReferenceProvider(tiecodeSelector, new TiecodeReferenceProvider(service)),
    vscode.languages.registerRenameProvider(tiecodeSelector, new TiecodeRenameProvider(service)),
    vscode.languages.registerSignatureHelpProvider(tiecodeSelector, new TiecodeSignatureHelpProvider(service), "(", ","),
    vscode.languages.registerDocumentSymbolProvider(tiecodeSelector, new TiecodeDocumentSymbolProvider(service)),
    vscode.languages.registerWorkspaceSymbolProvider(new TiecodeWorkspaceSymbolProvider(service)),
    vscode.languages.registerDocumentSemanticTokensProvider(tiecodeSelector, new TiecodeSemanticTokensProvider(service), semanticLegend),
    vscode.languages.registerCodeActionsProvider(tiecodeSelector, new TiecodeCodeActionProvider(service), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor]
    })
  );
}

class TiecodeCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | undefined> {
    return this.service.call(document, session => {
      const result = session.service.complete(this.service.createCompletionParams(session.tiec, document, position, context.triggerCharacter));
      const parsed = parseNativeResult(result) as any;
      return nativeListToArray(parsed?.items).map(item => toCompletionItem(item));
    });
  }
}

class TiecodeHoverProvider implements vscode.HoverProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    return this.service.call(document, session => {
      const result = session.service.hover(this.service.createCursorParams(session.tiec, document, position));
      const parsed = parseNativeResult(result) as any;
      if (!parsed?.text) {
        return undefined;
      }
      const content = parsed.kind === 1 ? new vscode.MarkdownString(parsed.text) : parsed.text;
      return new vscode.Hover(content);
    });
  }
}

class TiecodeFormattingProvider implements vscode.DocumentFormattingEditProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[] | undefined> {
    return this.service.call(document, session => {
      const result = session.service.format(document.uri.toString());
      const parsed = parseNativeResult(result) as any;
      const edits = toVscodeTextEdits(parsed?.edits);
      if (edits.length > 0) {
        return edits;
      }

      const formatted = session.tiec.IDEService?.formatText?.(document.getText());
      if (typeof formatted === "string" && formatted !== document.getText()) {
        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        return [vscode.TextEdit.replace(fullRange, formatted)];
      }
      return [];
    });
  }
}

class TiecodeDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | undefined> {
    return this.service.call(document, session => {
      const result = session.service.findDefinition(this.service.createCursorParams(session.tiec, document, position));
      const parsed = parseNativeResult(result) as any;
      return toVscodeLocation(parsed?.location);
    });
  }
}

class TiecodeReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideReferences(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
    return this.service.call(document, session => {
      const result = session.service.findReferences(this.service.createCursorParams(session.tiec, document, position));
      const parsed = parseNativeResult(result) as any;
      return nativeListToArray(parsed?.locations).map(toVscodeLocation).filter(isDefined);
    });
  }
}

class TiecodeRenameProvider implements vscode.RenameProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async prepareRename(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Range | { range: vscode.Range; placeholder: string } | undefined> {
    return this.service.call(document, session => {
      const result = session.service.prepareRename(this.service.createCursorParams(session.tiec, document, position));
      const parsed = parseNativeResult(result) as any;
      if (!parsed?.range) {
        return undefined;
      }
      return {
        range: toVscodeRange(parsed.range),
        placeholder: String(parsed.name ?? "")
      };
    });
  }

  async provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string): Promise<vscode.WorkspaceEdit | undefined> {
    return this.service.call(document, session => {
      const result = session.service.rename(this.service.createCursorParams(session.tiec, document, position), newName);
      const parsed = parseNativeResult(result) as any;
      return toWorkspaceEdit(parsed?.projectEdit ?? result?.projectEdit);
    });
  }
}

class TiecodeSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    context: vscode.SignatureHelpContext
  ): Promise<vscode.SignatureHelp | undefined> {
    return this.service.call(document, session => {
      const result = session.service.signatureHelp(this.service.createSignatureHelpParams(session.tiec, document, position, context.triggerCharacter));
      const parsed = parseNativeResult(result) as any;
      if (!parsed?.signature) {
        return undefined;
      }

      const help = new vscode.SignatureHelp();
      const signature = new vscode.SignatureInformation(String(parsed.signature));
      if (parsed.activeParameter) {
        signature.parameters = [new vscode.ParameterInformation(String(parsed.activeParameter))];
        help.activeParameter = 0;
      }
      help.signatures = [signature];
      help.activeSignature = 0;
      return help;
    });
  }
}

class TiecodeDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[] | undefined> {
    return this.service.call(document, session => {
      const result = session.service.sourceElements(document.uri.toString());
      const parsed = parseNativeResult(result) as any;
      return nativeListToArray(parsed?.elements).map(toDocumentSymbol).filter(isDefined);
    });
  }
}

class TiecodeWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[] | undefined> {
    const session = await this.service.getSession();
    if (!session) {
      return undefined;
    }

    const parsed = parseNativeResult(session.service.workspaceElements(query)) as any;
    const result: vscode.SymbolInformation[] = [];
    for (const [uri, elements] of Object.entries(parsed?.elements ?? {})) {
      for (const element of elements as any[]) {
        result.push(new vscode.SymbolInformation(
          String(element.name ?? ""),
          toSymbolKind(Number(element.kind ?? 0)),
          "",
          new vscode.Location(toVscodeUri(uri), toVscodeRange(element.range))
        ));
      }
    }
    return result;
  }
}

class TiecodeSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideDocumentSemanticTokens(document: vscode.TextDocument): Promise<vscode.SemanticTokens | undefined> {
    return this.service.call(document, session => {
      const result = session.service.highlight(document.uri.toString());
      const parsed = parseNativeResult(result) as any;
      const builder = new vscode.SemanticTokensBuilder(semanticLegend);
      for (const item of nativeListToArray(parsed?.highlights)) {
        const range = toVscodeRange((item as any).range);
        if (range.start.line === range.end.line && range.end.character > range.start.character) {
          builder.push(range, toTokenType(Number((item as any).kind ?? 0)));
        }
      }
      return builder.build();
    });
  }
}

class TiecodeCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideCodeActions(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[] | undefined> {
    return this.service.call(document, session => {
      const result = session.service.generateEvent(this.service.createCursorParams(session.tiec, document, range.start));
      const parsed = parseNativeResult(result) as any;
      return nativeListToArray(parsed?.actions).map(action => {
        const title = String((action as any).title ?? "生成事件方法");
        const codeAction = new vscode.CodeAction(title, vscode.CodeActionKind.Refactor);
        codeAction.edit = textEditsToWorkspaceEdit(document.uri, toVscodeTextEdits((action as any).edits));
        return codeAction;
      });
    });
  }
}

export async function generateEventAtCursor(service: TiecodeCompilerService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const result = await service.call(editor.document, session => {
    const params = service.createCursorParams(session.tiec, editor.document, editor.selection.active);
    return session.service.generateEvent(params);
  });
  const parsed = parseNativeResult(result) as any;
  const action = nativeListToArray(parsed?.actions)[0] as any;
  if (!action) {
    void vscode.window.showInformationMessage("当前位置没有可生成的事件。");
    return;
  }

  const edit = textEditsToWorkspaceEdit(editor.document.uri, toVscodeTextEdits(action.edits));
  await vscode.workspace.applyEdit(edit);
}

function toCompletionItem(item: any): vscode.CompletionItem {
  const completion = new vscode.CompletionItem(String(item?.label ?? ""), toCompletionKind(Number(item?.kind ?? 0)));
  completion.detail = item?.detail ? String(item.detail) : undefined;
  completion.sortText = item?.sortKey ? String(item.sortKey) : undefined;
  completion.insertText = item?.insertText ? String(item.insertText) : String(completion.label);
  completion.additionalTextEdits = toVscodeTextEdits(item?.extraEdits);
  return completion;
}

function toDocumentSymbol(sourceElement: any): vscode.DocumentSymbol | undefined {
  const element = sourceElement?.element;
  if (!element?.name || !element?.range) {
    return undefined;
  }

  const symbol = new vscode.DocumentSymbol(
    String(element.name),
    String(element.detail ?? ""),
    toSymbolKind(Number(element.kind ?? 0)),
    toVscodeRange(element.range),
    toVscodeRange(element.identifierRange ?? element.range)
  );
  symbol.children = nativeListToArray(sourceElement.children).map(toDocumentSymbol).filter(isDefined);
  return symbol;
}

function toCompletionKind(kind: number): vscode.CompletionItemKind {
  switch (kind) {
    case 0:
      return vscode.CompletionItemKind.Keyword;
    case 1:
      return vscode.CompletionItemKind.Snippet;
    case 2:
      return vscode.CompletionItemKind.Class;
    case 3:
      return vscode.CompletionItemKind.Variable;
    case 4:
      return vscode.CompletionItemKind.Method;
    case 5:
    case 6:
      return vscode.CompletionItemKind.Property;
    case 7:
      return vscode.CompletionItemKind.Event;
    case 8:
      return vscode.CompletionItemKind.Module;
    case 9:
      return vscode.CompletionItemKind.Value;
    case 10:
      return vscode.CompletionItemKind.File;
    default:
      return vscode.CompletionItemKind.Text;
  }
}

function toSymbolKind(kind: number): vscode.SymbolKind {
  switch (kind) {
    case 1:
      return vscode.SymbolKind.Class;
    case 2:
      return vscode.SymbolKind.Variable;
    case 3:
      return vscode.SymbolKind.Method;
    case 4:
    case 5:
      return vscode.SymbolKind.Property;
    case 6:
    case 7:
      return vscode.SymbolKind.Event;
    case 8:
      return vscode.SymbolKind.TypeParameter;
    case 9:
      return vscode.SymbolKind.Namespace;
    case 10:
      return vscode.SymbolKind.TypeParameter;
    default:
      return vscode.SymbolKind.Object;
  }
}

function toTokenType(kind: number): string {
  switch (kind) {
    case 1:
      return "class";
    case 2:
      return "variable";
    case 3:
      return "method";
    case 4:
    case 5:
      return "property";
    case 6:
    case 7:
      return "event";
    case 9:
      return "decorator";
    case 10:
      return "typeParameter";
    default:
      return "variable";
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
