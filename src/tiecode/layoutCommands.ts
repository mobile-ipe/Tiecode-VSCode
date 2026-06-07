import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { TiecodeCompilerService } from "./compilerService";
import { parseNativeResult, textEditsToWorkspaceEdit, toVscodeTextEdits } from "./interop";
import { ensureDirectory, getProjectInfo } from "./workspace";

export async function exportTlyLayout(service: TiecodeCompilerService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const text = await service.call(editor.document, session => {
    const params = service.createCursorParams(session.tiec, editor.document, editor.selection.active);
    const support = parseNativeResult(session.service.supportUIBinding(params)) as any;
    if (support && support.isSupport === false) {
      return undefined;
    }
    const format = session.tiec.TlySerializeFormat?.TLY_FORMAT ?? session.tiec.TLYSerializeFormat?.TLY_FORMAT ?? 0;
    return session.service.getUIBindings(params, format) as string | null;
  });

  if (!text) {
    void vscode.window.showInformationMessage("当前位置没有可导出的 TLY 布局。");
    return;
  }

  const project = getProjectInfo(editor.document.uri);
  if (!project) {
    return;
  }

  const layoutDir = path.join(project.rootPath, ".布局");
  ensureDirectory(layoutDir);
  const targetPath = path.join(layoutDir, `${path.basename(editor.document.fileName, ".t")}.tly`);
  fs.writeFileSync(targetPath, text, "utf8");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
  await vscode.window.showTextDocument(document, { preview: false });
}

export async function applyTlyLayout(service: TiecodeCompilerService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "tiecode") {
    void vscode.window.showInformationMessage("请先在要回写布局的结绳源码中定位到对应类。");
    return;
  }

  const project = getProjectInfo(editor.document.uri);
  const defaultUri = project ? vscode.Uri.file(path.join(project.rootPath, ".布局")) : undefined;
  const picked = await vscode.window.showOpenDialog({
    title: "选择 TLY 布局文件",
    defaultUri,
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      "TLY": ["tly"]
    }
  });
  if (!picked?.[0]) {
    return;
  }

  const tlyText = fs.readFileSync(picked[0].fsPath, "utf8");
  const result = await service.call(editor.document, session => {
    const params = service.createCursorParams(session.tiec, editor.document, editor.selection.active);
    const format = session.tiec.TlySerializeFormat?.TLY_FORMAT ?? session.tiec.TLYSerializeFormat?.TLY_FORMAT ?? 0;
    return session.service.editUIBindings(params, tlyText, format);
  });
  const parsed = parseNativeResult(result) as any;
  const edits = toVscodeTextEdits(parsed?.edits);
  if (edits.length === 0) {
    void vscode.window.showInformationMessage("TLY 布局没有产生源码修改。");
    return;
  }

  await vscode.workspace.applyEdit(textEditsToWorkspaceEdit(editor.document.uri, edits));
}
