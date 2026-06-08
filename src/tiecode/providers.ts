import * as path from "path";
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
import {
  filterAndSortPinyinCompletionItems,
  makePinyinCompletionFilterText,
  makePinyinCompletionSortText,
  shouldRequestBroadPinyinCompletion,
  sortPinyinCompletionItems,
  type PinyinCompletionTarget
} from "./pinyinCompletion";
import { getTiecodeHighlightEngine, SweetLineService, SweetLineSemanticToken } from "./sweetlineService";
import { getProjectInfo, isTiecodeDocument } from "./workspace";

const tiecodeSelector: vscode.DocumentSelector = [{ language: "tiecode", scheme: "file" }];
const tlySelector: vscode.DocumentSelector = [{ language: "tly", scheme: "file" }];
const semanticLegend = new vscode.SemanticTokensLegend(
  [
    "namespace",
    "type",
    "class",
    "enum",
    "interface",
    "struct",
    "typeParameter",
    "parameter",
    "variable",
    "property",
    "enumMember",
    "event",
    "function",
    "method",
    "macro",
    "keyword",
    "modifier",
    "comment",
    "string",
    "number",
    "regexp",
    "operator",
    "decorator"
  ],
  ["static", "deprecated", "readonly"]
);

export function registerTiecodeProviders(
  context: vscode.ExtensionContext,
  service: TiecodeCompilerService,
  sweetLineService: SweetLineService
): void {
  const semanticTokensProvider = new TiecodeSemanticTokensProvider(service, sweetLineService);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(tiecodeSelector, new TiecodeCompletionProvider(service), ".", ":", "@", "(", "\""),
    vscode.languages.registerCompletionItemProvider(tlySelector, new TlyCompletionProvider(service), "@", "{", ",", "="),
    vscode.languages.registerHoverProvider(tiecodeSelector, new TiecodeHoverProvider(service)),
    vscode.languages.registerDocumentFormattingEditProvider(tiecodeSelector, new TiecodeFormattingProvider(service)),
    vscode.languages.registerDocumentFormattingEditProvider(tlySelector, new TlyFormattingProvider(service)),
    vscode.languages.registerDefinitionProvider(tiecodeSelector, new TiecodeDefinitionProvider(service)),
    vscode.languages.registerReferenceProvider(tiecodeSelector, new TiecodeReferenceProvider(service)),
    vscode.languages.registerRenameProvider(tiecodeSelector, new TiecodeRenameProvider(service)),
    vscode.languages.registerSignatureHelpProvider(tiecodeSelector, new TiecodeSignatureHelpProvider(service), "(", ","),
    vscode.languages.registerDocumentSymbolProvider(tiecodeSelector, new TiecodeDocumentSymbolProvider(service)),
    vscode.languages.registerWorkspaceSymbolProvider(new TiecodeWorkspaceSymbolProvider(service)),
    vscode.languages.registerDocumentSemanticTokensProvider(tiecodeSelector, semanticTokensProvider, semanticLegend),
    vscode.languages.registerDocumentRangeSemanticTokensProvider(tiecodeSelector, semanticTokensProvider, semanticLegend),
    vscode.languages.registerDocumentSemanticTokensProvider(tlySelector, semanticTokensProvider, semanticLegend),
    vscode.languages.registerDocumentRangeSemanticTokensProvider(tlySelector, semanticTokensProvider, semanticLegend),
    vscode.languages.registerCodeActionsProvider(tiecodeSelector, new TiecodeCodeActionProvider(service), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
  );
}

class TiecodeCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | undefined> {
    return withCancellation(this.service, document.uri, token, () => this.service.call(document, session => {
      const partial = getCompletionPartial(document, position);
      const result = session.service.complete(this.service.createCompletionParams(session.tiec, document, position, context.triggerCharacter));
      const parsed = parseNativeResult(result) as any;
      let nativeItems = nativeListToArray(parsed?.items);

      if (shouldRequestBroadPinyinCompletion(partial)) {
        const broadParams = this.service.createCompletionParams(session.tiec, document, position, context.triggerCharacter);
        broadParams.partial = "";
        const broadResult = session.service.complete(broadParams);
        const broadParsed = parseNativeResult(broadResult) as any;
        const pinyinItems = filterAndSortPinyinCompletionItems(nativeListToArray(broadParsed?.items), partial, toPinyinCompletionTarget);
        nativeItems = mergeCompletionItems(nativeItems, pinyinItems);
      }

      nativeItems = sortPinyinCompletionItems(nativeItems, partial, toPinyinCompletionTarget);
      return nativeItems.map(item => toCompletionItem(item, document, position, partial));
    }));
  }
}

class TiecodeHoverProvider implements vscode.HoverProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    return withCancellation(this.service, document.uri, token, () => this.service.call(document, session => {
      const result = session.service.hover(this.service.createCursorParams(session.tiec, document, position));
      const parsed = parseNativeResult(result) as any;
      if (!parsed?.text) {
        return undefined;
      }
      const content = parsed.kind === 1 ? new vscode.MarkdownString(parsed.text) : parsed.text;
      return new vscode.Hover(content);
    }));
  }
}

class TiecodeFormattingProvider implements vscode.DocumentFormattingEditProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[] | undefined> {
    return this.service.call(document, session => {
      const result = session.service.format(this.service.createUri(session.tiec, document.uri));
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

class TlyCompletionProvider implements vscode.CompletionItemProvider {
  private cachedProjectRoot?: string;
  private cachedItems?: TlyCompletionItems;

  constructor(private readonly service: TiecodeCompilerService) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | undefined> {
    return withCancellation(this.service, document.uri, token, async () => {
      const session = await this.service.getSession(document.uri);
      if (!session) {
        return undefined;
      }

      const completeTly = session.service.completeTLY ?? session.service.completeTly;
      if (typeof completeTly === "function") {
        const params = this.service.createCompletionParams(session.tiec, document, position, context.triggerCharacter);
        const result = completeTly.call(session.service, document.getText(), params);
        const parsed = parseNativeResult(result) as any;
        const partial = getCompletionPartial(document, position);
        const nativeItems = sortPinyinCompletionItems(nativeListToArray(parsed?.items), partial, toPinyinCompletionTarget);
        const items = nativeItems.map(item => toCompletionItem(item, document, position, partial));
        if (items.length > 0) {
          return items;
        }
      }

      const scanned = await this.getScannedItems(session);
      return shouldCompleteTlyProperty(document, position)
        ? scanned.properties
        : [...scanned.views, ...scanned.properties];
    });
  }

  private async getScannedItems(session: any): Promise<TlyCompletionItems> {
    if (this.cachedProjectRoot === session.project.rootPath && this.cachedItems) {
      return this.cachedItems;
    }

    const parsed = parseNativeResult(session.service.scanUIClasses?.()) as any;
    const viewClasses = nativeListToArray<any>(parsed?.viewClasses);
    const basicProperties = nativeListToArray<any>(parsed?.basicProperties);
    const propertyNames = new Set<string>();

    for (const property of basicProperties) {
      addPropertyName(propertyNames, property);
    }
    for (const viewClass of viewClasses) {
      for (const property of nativeListToArray<any>(viewClass.viewProperties)) {
        addPropertyName(propertyNames, property);
      }
      for (const property of nativeListToArray<any>(viewClass.containerProperties)) {
        addPropertyName(propertyNames, property);
      }
    }

    const items = {
      views: viewClasses
        .map(viewClass => toTlyViewCompletionItem(viewClass))
        .filter(isDefined),
      properties: [...propertyNames]
        .sort((left, right) => left.localeCompare(right))
        .map(toTlyPropertyCompletionItem)
    };
    this.cachedProjectRoot = session.project.rootPath;
    this.cachedItems = items;
    return items;
  }
}

class TlyFormattingProvider implements vscode.DocumentFormattingEditProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[] | undefined> {
    const session = await this.service.getSession(document.uri);
    const formatted = session?.tiec.IDEService?.formatText?.(document.getText());
    if (typeof formatted === "string" && formatted !== document.getText()) {
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
      return [vscode.TextEdit.replace(fullRange, formatted)];
    }
    return [];
  }
}

class TiecodeDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
    return withCancellation(this.service, document.uri, token, () => this.service.call(document, session => {
      const result = session.service.findDefinition(this.service.createCursorParams(session.tiec, document, position));
      const parsed = parseNativeResult(result) as any;
      return toVscodeLocation(parsed?.location);
    }));
  }
}

class TiecodeReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[] | undefined> {
    return withCancellation(this.service, document.uri, token, () => this.service.call(document, session => {
      const params = this.service.createCursorParams(session.tiec, document, position);
      const result = session.service.findReferences(params);
      const parsed = parseNativeResult(result) as any;
      const locations = nativeListToArray(parsed?.locations).map(toVscodeLocation).filter(isDefined);
      if (context.includeDeclaration) {
        return locations;
      }

      const definitionResult = session.service.findDefinition(this.service.createCursorParams(session.tiec, document, position));
      const definition = toVscodeLocation((parseNativeResult(definitionResult) as any)?.location);
      return definition ? locations.filter(location => !sameLocation(location, definition)) : locations;
    }));
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
      const edit = toWorkspaceEdit(parsed?.projectEdit);
      if (edit.size > 0 || !result?.projectEdit) {
        return edit;
      }
      return toWorkspaceEdit(result.projectEdit);
    });
  }
}

class TiecodeSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.SignatureHelpContext
  ): Promise<vscode.SignatureHelp | undefined> {
    return withCancellation(this.service, document.uri, token, () => this.service.call(document, session => {
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
    }));
  }
}

class TiecodeDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[] | undefined> {
    return this.service.call(document, session => {
      const result = session.service.sourceElements(this.service.createUri(session.tiec, document.uri));
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
    for (const [uri, elements] of workspaceElementEntries(parsed?.elements)) {
      for (const element of elements) {
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

class TiecodeSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider, vscode.DocumentRangeSemanticTokensProvider {
  constructor(
    private readonly service: TiecodeCompilerService,
    private readonly sweetLineService: SweetLineService
  ) {}

  async provideDocumentSemanticTokens(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.SemanticTokens | undefined> {
    return this.provideTokens(document, undefined, token);
  }

  async provideDocumentRangeSemanticTokens(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): Promise<vscode.SemanticTokens | undefined> {
    return this.provideTokens(document, range, token);
  }

  private async provideTokens(document: vscode.TextDocument, range: vscode.Range | undefined, token: vscode.CancellationToken): Promise<vscode.SemanticTokens | undefined> {
    const highlightEngine = getTiecodeHighlightEngine();
    if (highlightEngine === "textmate") {
      return undefined;
    }

    if (highlightEngine !== "compiler") {
      if (token.isCancellationRequested) {
        return undefined;
      }
      const sweetLineTokens = await this.sweetLineService.provideSemanticTokens(document, range);
      if (token.isCancellationRequested) {
        return undefined;
      }
      if (sweetLineTokens) {
        return this.buildSweetLineTokens(document, sweetLineTokens);
      }
      if (highlightEngine === "sweetline" || !isTiecodeDocument(document)) {
        return undefined;
      }
    }

    if (!isTiecodeDocument(document)) {
      return undefined;
    }

    return withCancellation(this.service, document.uri, token, () => this.service.call(document, session => {
      const uri = this.service.createUri(session.tiec, document.uri);
      const result = range && session.service.highlightRange
        ? session.service.highlightRange(uri, range.start.line, range.end.line + 1)
        : session.service.highlight(uri);
      const parsed = parseNativeResult(result) as any;
      const builder = new vscode.SemanticTokensBuilder(semanticLegend);
      for (const item of nativeListToArray(parsed?.highlights)) {
        const range = toVscodeRange((item as any).range);
        pushSemanticToken(builder, document, range, toTokenType(Number((item as any).kind ?? 0)), toTokenModifiers((item as any).tags));
      }
      return builder.build();
    }));
  }

  private buildSweetLineTokens(document: vscode.TextDocument, tokens: SweetLineSemanticToken[]): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(semanticLegend);
    for (const token of tokens) {
      pushSemanticToken(builder, document, token.range, token.tokenType, token.tokenModifiers);
    }
    return builder.build();
  }
}

class TiecodeCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly service: TiecodeCompilerService) {}

  async provideCodeActions(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[] | undefined> {
    return this.service.call(document, session => {
      const params = this.service.createCursorParams(session.tiec, document, range.start);
      const result = session.service.generateEvent(params);
      const parsed = parseNativeResult(result) as any;
      const actions = nativeListToArray(parsed?.actions).map(action => {
        const title = String((action as any).title ?? "生成事件方法");
        const codeAction = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        codeAction.edit = textEditsToWorkspaceEdit(document.uri, toVscodeTextEdits((action as any).edits));
        return codeAction;
      });

      const smartEnter = parseNativeResult(session.service.smartEnter?.(params)) as any;
      if (Number(smartEnter?.kind ?? 0) > 0) {
        const action = new vscode.CodeAction("智能键入", vscode.CodeActionKind.QuickFix);
        action.command = { command: "tiecode.smartEnter", title: "智能键入" };
        actions.push(action);
      }
      return actions;
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
  const actions = nativeListToArray(parsed?.actions);
  if (actions.length === 0) {
    void vscode.window.showInformationMessage("当前位置没有可生成的事件。");
    return;
  }

  const action = actions.length === 1
    ? actions[0]
    : await pickGeneratedEventAction(actions);
  if (!action) {
    return;
  }

  const edit = textEditsToWorkspaceEdit(editor.document.uri, toVscodeTextEdits((action as any).edits));
  await vscode.workspace.applyEdit(edit);
}

export async function smartEnterAtCursor(service: TiecodeCompilerService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const result = await service.call(editor.document, session => {
    const params = service.createCursorParams(session.tiec, editor.document, editor.selection.active);
    return session.service.smartEnter?.(params);
  });
  const smartEnter = parseNativeResult(result) as any;
  const kind = Number(smartEnter?.kind ?? 0);
  if (!smartEnter?.range || kind === 0) {
    void vscode.window.showInformationMessage("当前位置没有可执行的智能键入。");
    return;
  }

  const value = await pickSmartEnterValue(kind, smartEnter, editor.document);
  if (value === undefined) {
    return;
  }

  const replaceFormat = String(smartEnter.replaceFormat ?? "%s");
  const edit = textEditsToWorkspaceEdit(editor.document.uri, [
    vscode.TextEdit.replace(toVscodeRange(smartEnter.range), formatSmartEnterText(replaceFormat, value))
  ]);
  await vscode.workspace.applyEdit(edit);
}

export async function scanUiClasses(service: TiecodeCompilerService, output: vscode.OutputChannel): Promise<void> {
  const session = await service.getSession(vscode.window.activeTextEditor?.document.uri);
  if (!session) {
    void vscode.window.showErrorMessage("没有打开结绳工程。");
    return;
  }

  const parsed = parseNativeResult(session.service.scanUIClasses?.()) as any;
  const viewClasses = nativeListToArray<any>(parsed?.viewClasses);
  const basicProperties = nativeListToArray<any>(parsed?.basicProperties);
  output.show(true);
  output.appendLine("结绳可视化组件扫描结果");
  output.appendLine(`基础属性: ${basicProperties.map(property => String(property.name ?? "")).filter(Boolean).join("、") || "无"}`);
  output.appendLine(`组件数量: ${viewClasses.length}`);
  for (const viewClass of viewClasses) {
    const viewProperties = nativeListToArray<any>(viewClass.viewProperties).map(property => property.name).filter(Boolean).join("、");
    const containerProperties = nativeListToArray<any>(viewClass.containerProperties).map(property => property.name).filter(Boolean).join("、");
    output.appendLine(`- ${String(viewClass.name ?? "")}${viewClass.isContainer ? " [容器]" : ""}`);
    if (viewProperties) {
      output.appendLine(`  属性: ${viewProperties}`);
    }
    if (containerProperties) {
      output.appendLine(`  子组件布局属性: ${containerProperties}`);
    }
  }
  void vscode.window.showInformationMessage(`结绳可视化组件扫描完成: ${viewClasses.length} 个组件`);
}

export async function showSyncedSource(service: TiecodeCompilerService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isTiecodeDocument(editor.document)) {
    void vscode.window.showInformationMessage("请先打开一个结绳源代码文件。");
    return;
  }

  const sourceText = await service.call(editor.document, session => {
    const uri = service.createUri(session.tiec, editor.document.uri);
    return session.service.getSourceText?.(uri);
  });
  if (typeof sourceText !== "string") {
    void vscode.window.showErrorMessage("无法从 IDE Service 读取同步后的源代码。");
    return;
  }

  const document = await vscode.workspace.openTextDocument({
    language: "tiecode",
    content: sourceText
  });
  await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

function toCompletionItem(
  item: any,
  document?: vscode.TextDocument,
  position?: vscode.Position,
  partial?: string
): vscode.CompletionItem {
  const kind = Number(item?.kind ?? 0);
  const label = String(item?.label ?? "");
  const completion = new vscode.CompletionItem(label, toCompletionKind(kind));
  const defaultInsertText = item?.insertText ? String(item.insertText) : label;
  const defaultRange = document && position ? getCompletionRange(document, position) : undefined;
  const extraEdits = toVscodeTextEdits(item?.extraEdits);
  const mainEditIndex = findMainCompletionEdit(extraEdits, defaultRange, String(item?.insertText ?? ""));
  const mainEdit = mainEditIndex >= 0 ? extraEdits[mainEditIndex] : undefined;
  const insertText = mainEdit?.newText ?? defaultInsertText;
  const pinyinTarget = toPinyinCompletionTarget(item, label, insertText);
  completion.detail = item?.detail ? String(item.detail) : undefined;
  completion.sortText = makePinyinCompletionSortText(pinyinTarget, partial, item?.sortKey ? String(item.sortKey) : undefined);
  completion.filterText = item?.filterText
    ? String(item.filterText)
    : makeCompletionFilterText(pinyinTarget, partial);
  if (mainEdit) {
    completion.range = mainEdit.range;
  } else if (defaultRange) {
    completion.range = defaultRange;
  }
  completion.insertText = kind === 1 ? new vscode.SnippetString(insertText) : insertText;
  completion.additionalTextEdits = mainEditIndex >= 0
    ? extraEdits.filter((_, index) => index !== mainEditIndex)
    : extraEdits;
  if (item?.documentation) {
    completion.documentation = String(item.documentation);
  }
  return completion;
}

interface TlyCompletionItems {
  views: vscode.CompletionItem[];
  properties: vscode.CompletionItem[];
}

function toTlyViewCompletionItem(viewClass: any): vscode.CompletionItem | undefined {
  const name = String(viewClass?.name ?? "");
  if (!name) {
    return undefined;
  }

  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
  item.detail = viewClass?.isContainer ? "TLY 容器组件" : "TLY 组件";
  item.insertText = new vscode.SnippetString(`${name} {\n    $0\n}`);
  return item;
}

function toTlyPropertyCompletionItem(name: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
  item.detail = "TLY 属性";
  item.insertText = new vscode.SnippetString(`${name} = $0`);
  return item;
}

function addPropertyName(target: Set<string>, property: any): void {
  const name = String(property?.name ?? "");
  if (name) {
    target.add(name);
  }
}

function shouldCompleteTlyProperty(document: vscode.TextDocument, position: vscode.Position): boolean {
  const beforeCursor = document.lineAt(position.line).text.slice(0, position.character);
  if (beforeCursor.includes("=")) {
    return false;
  }
  if (beforeCursor.trim().length === 0) {
    return beforeCursor.length > 0;
  }
  return /^\s+[\p{L}_][\p{L}\p{N}_]*$/u.test(beforeCursor);
}

async function pickGeneratedEventAction(actions: any[]): Promise<any | undefined> {
  const picked = await vscode.window.showQuickPick(actions.map((action, index) => ({
    label: String(action?.title ?? "生成事件方法"),
    description: `${index + 1}/${actions.length}`,
    action
  })), {
    title: "选择要生成的事件或虚方法"
  });
  return picked?.action;
}

function getCompletionRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
  const beforeCursor = document.lineAt(position.line).text.slice(0, position.character);
  const partial = beforeCursor.match(/[\p{L}\p{N}_@]+$/u)?.[0] ?? "";
  return new vscode.Range(position.line, position.character - partial.length, position.line, position.character);
}

function getCompletionPartial(document: vscode.TextDocument, position: vscode.Position): string {
  return document.getText(getCompletionRange(document, position));
}

function findMainCompletionEdit(edits: vscode.TextEdit[], defaultRange: vscode.Range | undefined, insertText: string): number {
  if (edits.length === 0) {
    return -1;
  }
  if (!insertText && edits.length === 1) {
    return 0;
  }
  if (!defaultRange) {
    return -1;
  }
  return edits.findIndex(edit => rangesOverlapOrTouch(edit.range, defaultRange));
}

function rangesOverlapOrTouch(left: vscode.Range, right: vscode.Range): boolean {
  const intersection = left.intersection(right);
  if (intersection && (!intersection.isEmpty || left.isEmpty || right.isEmpty)) {
    return true;
  }
  return left.start.isEqual(right.start) || left.end.isEqual(right.end);
}

function makeCompletionFilterText(target: PinyinCompletionTarget, partial?: string): string | undefined {
  return makePinyinCompletionFilterText(target, partial);
}

function toPinyinCompletionTarget(item: any, label?: string, insertText?: string): PinyinCompletionTarget {
  const itemLabel = label ?? String(item?.label ?? "");
  return {
    label: itemLabel,
    insertText: insertText ?? (item?.insertText ? String(item.insertText) : itemLabel),
    symbolName: item?.symbolName ? String(item.symbolName) : undefined,
    sortText: item?.sortKey ? String(item.sortKey) : undefined
  };
}

function mergeCompletionItems(primary: any[], secondary: any[]): any[] {
  const merged = [...primary];
  const keys = new Set(primary.map(completionItemIdentity));
  for (const item of secondary) {
    const key = completionItemIdentity(item);
    if (!keys.has(key)) {
      keys.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function completionItemIdentity(item: any): string {
  return [
    String(item?.kind ?? ""),
    String(item?.label ?? ""),
    String(item?.detail ?? ""),
    String(item?.symbolName ?? ""),
    String(item?.insertText ?? "")
  ].join("\u0000");
}

function toDocumentSymbol(sourceElement: any): vscode.DocumentSymbol | undefined {
  const element = sourceElement?.element ?? sourceElement;
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
  symbol.children = nativeListToArray(sourceElement.children ?? element.children).map(toDocumentSymbol).filter(isDefined);
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
      return vscode.CompletionItemKind.Reference;
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

function toTokenModifiers(tags: any): string[] {
  const modifiers: string[] = [];
  for (const tag of nativeListToArray(tags).map(value => Number(value))) {
    if (tag === 1) {
      modifiers.push("static");
    }
    if (tag === 2) {
      modifiers.push("deprecated");
    }
  }
  return modifiers;
}

function pushSemanticToken(
  builder: vscode.SemanticTokensBuilder,
  document: vscode.TextDocument,
  range: vscode.Range,
  tokenType: string,
  tokenModifiers: string[]
): void {
  const startLine = Math.max(0, Math.min(range.start.line, document.lineCount - 1));
  const endLine = Math.max(startLine, Math.min(range.end.line, document.lineCount - 1));
  for (let line = startLine; line <= endLine; line += 1) {
    const lineText = document.lineAt(line).text;
    const startCharacter = line === range.start.line ? Math.min(range.start.character, lineText.length) : 0;
    const endCharacter = line === range.end.line ? Math.min(range.end.character, lineText.length) : lineText.length;
    if (endCharacter > startCharacter) {
      builder.push(new vscode.Range(line, startCharacter, line, endCharacter), tokenType, tokenModifiers);
    }
  }
}

function sameLocation(left: vscode.Location, right: vscode.Location): boolean {
  return left.uri.toString() === right.uri.toString() && left.range.isEqual(right.range);
}

function workspaceElementEntries(elements: any): Array<[string, any[]]> {
  const parsed = parseNativeResult(elements) as any;
  if (!parsed) {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed
      .map(entry => [String(entry.uri ?? entry.file ?? entry.path ?? ""), nativeListToArray(entry.elements ?? entry.value ?? entry.items)] as [string, any[]])
      .filter(([uri]) => uri.length > 0);
  }
  if (typeof parsed === "object") {
    return Object.entries(parsed).map(([uri, value]) => [uri, nativeListToArray(value)] as [string, any[]]);
  }
  return [];
}

async function pickSmartEnterValue(kind: number, smartEnter: any, document: vscode.TextDocument): Promise<string | undefined> {
  if (kind === 1) {
    const project = getProjectInfo(document.uri);
    const picked = await vscode.window.showOpenDialog({
      title: "选择文件",
      defaultUri: project ? vscode.Uri.file(project.rootPath) : undefined,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false
    });
    if (!picked?.[0]) {
      return undefined;
    }
    if (!project) {
      return picked[0].fsPath.replace(/\\/g, "/");
    }
    const relative = path.relative(project.rootPath, picked[0].fsPath);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.replace(/\\/g, "/") : picked[0].fsPath.replace(/\\/g, "/");
  }

  if (kind === 2) {
    const picked = await vscode.window.showQuickPick(nativeListToArray(smartEnter.enums).map(value => String(value)), {
      title: "选择属性值"
    });
    return picked;
  }

  if (kind === 3) {
    return smartEnter.isTrue ? "假" : "真";
  }

  return undefined;
}

function formatSmartEnterText(replaceFormat: string, value: string): string {
  if (replaceFormat.includes("%s")) {
    return replaceFormat.split("%s").join(value);
  }
  return `${replaceFormat}${value}`;
}

async function withCancellation<T>(
  service: TiecodeCompilerService,
  uri: vscode.Uri,
  token: vscode.CancellationToken,
  callback: () => Promise<T | undefined>
): Promise<T | undefined> {
  if (token.isCancellationRequested) {
    void service.cancel(uri);
    return undefined;
  }

  const disposable = token.onCancellationRequested(() => {
    void service.cancel(uri);
  });
  try {
    const result = await callback();
    return token.isCancellationRequested ? undefined : result;
  } finally {
    disposable.dispose();
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
