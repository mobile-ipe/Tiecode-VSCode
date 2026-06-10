import * as vscode from "vscode";
import { TiecodeCompilerService } from "./compilerService";
import { nativeListToArray, parseNativeResult, textEditsToWorkspaceEdit, toVscodeRange, toVscodeTextEdits } from "./interop";
import { createDefaultRoot, LayoutDesignerState, normalizeEditableProperties, normalizeViewClasses, parseTlyJson, TlyEntity } from "./layoutDesignerModel";

const tiecodeSelector: vscode.DocumentSelector = [{ language: "tiecode", scheme: "file" }];
const OPEN_LAYOUT_DESIGNER_COMMAND = "tiecode.openLayoutDesigner";
const ELEMENT_KIND_CLASS = 1;
const LAYOUT_DESIGNER_VIEW_TYPE = "tiecode.layoutDesigner";

interface OpenLayoutDesignerArgs {
  uri?: vscode.Uri;
  position?: vscode.Position;
}

interface LayoutDesignerCodeLensEntry {
  range: vscode.Range;
  position: vscode.Position;
}

export function registerLayoutDesigner(context: vscode.ExtensionContext, service: TiecodeCompilerService): void {
  const provider = new LayoutDesignerCodeLensProvider(service);
  context.subscriptions.push(
    provider,
    vscode.commands.registerCommand(OPEN_LAYOUT_DESIGNER_COMMAND, args => openLayoutDesigner(context, service, args)),
    vscode.languages.registerCodeLensProvider(tiecodeSelector, provider),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === "tiecode") {
        provider.invalidate(event.document.uri);
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      provider.invalidate(document.uri);
    })
  );
}

async function openLayoutDesigner(context: vscode.ExtensionContext, service: TiecodeCompilerService, args?: OpenLayoutDesignerArgs): Promise<void> {
  const editor = await resolveEditor(args?.uri);
  if (!editor) {
    void vscode.window.showInformationMessage("请先打开一个结绳源代码文件。");
    return;
  }

  const position = args?.position ?? editor.selection.active;
  const support = await getLayoutSupport(service, editor.document, position);
  if (!support?.isSupport) {
    void vscode.window.showInformationMessage("当前位置不支持布局设计，请在支持布局的类中打开。");
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    LAYOUT_DESIGNER_VIEW_TYPE,
    `布局设计器${support.element?.name ? ` - ${String(support.element.name)}` : ""}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media", "layoutDesigner")]
    }
  );
  const descriptor = { uri: editor.document.uri, position };
  const loadState = async (): Promise<LayoutDesignerState | undefined> => {
    const currentDocument = await vscode.workspace.openTextDocument(editor.document.uri);
    return createDesignerState(service, currentDocument, position, String(support.element?.name ?? ""));
  };

  const initialState = await loadState();
  if (!initialState) {
    panel.dispose();
    return;
  }

  panel.webview.html = createDesignerHtml(context, panel.webview, initialState);
  const messageSubscription = panel.webview.onDidReceiveMessage(async message => {
    if (message?.command === "save") {
      try {
        const saved = await saveDesignerLayout(service, descriptor.uri, descriptor.position, message.root);
        await panel.webview.postMessage({ command: saved ? "saved" : "saveFailed" });
      } catch (error) {
        void vscode.window.showErrorMessage(`布局保存失败: ${String(error instanceof Error ? error.message : error)}`);
        await panel.webview.postMessage({ command: "saveFailed" });
      }
      return;
    }
    if (message?.command === "refresh") {
      const state = await loadState();
      if (state) {
        await panel.webview.postMessage({ command: "load", state });
      }
    }
  });
  panel.onDidDispose(() => messageSubscription.dispose());
}

class LayoutDesignerCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  private readonly cache = new Map<string, { version: number; entries: LayoutDesignerCodeLensEntry[] }>();

  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private readonly service: TiecodeCompilerService) {}

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const entries = await this.getEntries(document, token);
    if (token.isCancellationRequested) {
      return [];
    }

    return entries.map(entry => new vscode.CodeLens(entry.range, {
      title: "打开布局设计器",
      command: OPEN_LAYOUT_DESIGNER_COMMAND,
      arguments: [{ uri: document.uri, position: entry.position }]
    }));
  }

  invalidate(uri?: vscode.Uri): void {
    if (uri) {
      this.cache.delete(uri.toString());
    } else {
      this.cache.clear();
    }
    this.onDidChangeCodeLensesEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeCodeLensesEmitter.dispose();
    this.cache.clear();
  }

  private async getEntries(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<LayoutDesignerCodeLensEntry[]> {
    const cacheKey = document.uri.toString();
    const cached = this.cache.get(cacheKey);
    if (cached?.version === document.version) {
      return cached.entries;
    }

    const entries = await this.collectEntries(document, token);
    if (!token.isCancellationRequested) {
      this.cache.set(cacheKey, { version: document.version, entries });
    }
    return entries;
  }

  private async collectEntries(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<LayoutDesignerCodeLensEntry[]> {
    const entries = await this.service.call(document, session => {
      if (token.isCancellationRequested) {
        return [];
      }

      const uri = this.service.createUri(session.tiec, document.uri);
      const parsed = parseNativeResult(session.service.sourceElements(uri)) as any;
      const entries: LayoutDesignerCodeLensEntry[] = [];
      for (const element of flattenSourceElements(parsed?.elements)) {
        if (token.isCancellationRequested) {
          return [];
        }
        if (!isClassElement(session.tiec, element)) {
          continue;
        }

        const range = toVscodeRange(element.identifierRange ?? element.range);
        const position = range.start;
        const support = parseNativeResult(session.service.supportUIBinding(this.service.createCursorParams(session.tiec, document, position))) as any;
        if (support?.isSupport) {
          entries.push({ range, position });
        }
      }
      return entries;
    });
    return entries ?? [];
  }
}

async function resolveEditor(uri?: vscode.Uri): Promise<vscode.TextEditor | undefined> {
  const active = vscode.window.activeTextEditor;
  if (!uri || active?.document.uri.toString() === uri.toString()) {
    return active;
  }

  const document = await vscode.workspace.openTextDocument(uri);
  if (document.languageId !== "tiecode") {
    return undefined;
  }
  return vscode.window.showTextDocument(document, { preview: false });
}

async function getLayoutSupport(
  service: TiecodeCompilerService,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<any | undefined> {
  return service.call(document, session => {
    const params = service.createCursorParams(session.tiec, document, position);
    return parseNativeResult(session.service.supportUIBinding(params));
  });
}

async function createDesignerState(
  service: TiecodeCompilerService,
  document: vscode.TextDocument,
  position: vscode.Position,
  className: string
): Promise<LayoutDesignerState | undefined> {
  const state = await service.call(document, session => {
    const params = service.createCursorParams(session.tiec, document, position);
    const format = getJsonTlyFormat(session.tiec);
    const layoutText = session.service.getUIBindings(params, format);
    const classInfoResult = parseNativeResult(session.service.scanUIClasses?.()) as any;
    const viewClasses = normalizeViewClasses(nativeListToArray(classInfoResult?.viewClasses));
    const basicProperties = normalizeEditableProperties(nativeListToArray(classInfoResult?.basicProperties));
    let root: TlyEntity | undefined;
    let parseFailed = false;
    if (typeof layoutText === "string" && layoutText.trim()) {
      try {
        root = parseTlyJson(layoutText);
      } catch {
        parseFailed = true;
        root = undefined;
      }
    }
    if (parseFailed) {
      return undefined;
    }
    root = root ?? createDefaultRoot(viewClasses);
    if (!root) {
      return undefined;
    }

    return {
      title: className || "布局设计器",
      sourcePath: document.uri.fsPath,
      root,
      viewClasses,
      basicProperties
    };
  });

  if (!state) {
    void vscode.window.showErrorMessage("无法读取布局设计数据。");
  }
  return state;
}

async function saveDesignerLayout(
  service: TiecodeCompilerService,
  uri: vscode.Uri,
  position: vscode.Position,
  root: TlyEntity
): Promise<boolean> {
  const document = await vscode.workspace.openTextDocument(uri);
  const edits = await service.call(document, session => {
    const params = service.createCursorParams(session.tiec, document, position);
    const result = session.service.editUIBindings(params, JSON.stringify(root), getJsonTlyFormat(session.tiec));
    const parsed = parseNativeResult(result) as any;
    return toVscodeTextEdits(parsed?.edits);
  });

  if (!edits || edits.length === 0) {
    void vscode.window.showInformationMessage("布局没有产生源码修改。");
    return true;
  }

  const workspaceEdit = textEditsToWorkspaceEdit(uri, edits);
  const success = await vscode.workspace.applyEdit(workspaceEdit);
  if (success) {
    void vscode.window.showInformationMessage("布局已保存到结绳源码。");
    return true;
  } else {
    void vscode.window.showErrorMessage("布局保存失败。");
    return false;
  }
}

function getJsonTlyFormat(tiec: any): number {
  return Number(tiec.TlySerializeFormat?.JSON_FORMAT ?? tiec.TLYSerializeFormat?.JSON_FORMAT ?? 1);
}

function createDesignerHtml(context: vscode.ExtensionContext, webview: vscode.Webview, state: LayoutDesignerState): string {
  const nonce = createNonce();
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media", "layoutDesigner");
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "layoutDesigner.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "layoutDesigner.js"));
  const stateJson = JSON.stringify(state).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>结绳布局设计器</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">window.__TIECODE_LAYOUT_DESIGNER_STATE__ = ${stateJson};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function flattenSourceElements(elements: any): any[] {
  const result: any[] = [];
  const visit = (items: any): void => {
    for (const item of nativeListToArray<any>(items)) {
      const element = item?.element ?? item;
      if (element) {
        result.push(element);
      }
      visit(item?.children);
    }
  };
  visit(elements);
  return result;
}

function isClassElement(tiec: any, element: any): boolean {
  const classKind = Number(tiec?.ElementKind?.CLASS ?? ELEMENT_KIND_CLASS);
  return Number(element?.kind ?? -1) === classKind;
}
