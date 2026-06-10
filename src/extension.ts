import * as vscode from "vscode";
import { registerBuildCommands } from "./tiecode/build";
import { registerConfigView } from "./tiecode/configView";
import { TiecodeCompilerService } from "./tiecode/compilerService";
import { TiecodeDiagnostics } from "./tiecode/diagnostics";
import { applyTlyLayout, exportTlyLayout } from "./tiecode/layoutCommands";
import { AndroidLogcatService } from "./tiecode/logcat";
import { openTiecodeProject } from "./tiecode/projectLifecycle";
import { generateEventAtCursor, registerTiecodeProviders, scanUiClasses, showSyncedSource, smartEnterAtCursor } from "./tiecode/providers";
import { registerRunCommands } from "./tiecode/run";
import { SourceMappingService } from "./tiecode/sourceMapping";
import { SweetLineService } from "./tiecode/sweetlineService";
import { registerTemplateCommands } from "./tiecode/templates";
import { ToolchainService } from "./tiecode/toolchain";
import { registerTspImport } from "./tiecode/tspImport";
import { TiecodeWasmBuildService } from "./tiecode/wasmBuild";
import { isProjectConfigUri, isTiecodeDocument, isTiecodeRelatedDocument } from "./tiecode/workspace";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("结绳");
  const compilerService = new TiecodeCompilerService(context, output);
  const sweetLineService = new SweetLineService(context, output);
  const toolchainService = new ToolchainService(context, output);
  const sourceMappingService = new SourceMappingService(context, output);
  const logcatService = new AndroidLogcatService();
  const wasmBuildService = new TiecodeWasmBuildService(context, output);
  const diagnostics = new TiecodeDiagnostics(
    compilerService,
    vscode.languages.createDiagnosticCollection("tiecode"),
    output
  );

  context.subscriptions.push(output, diagnostics, sweetLineService, sourceMappingService, logcatService);
  registerTiecodeProviders(context, compilerService, sweetLineService);
  registerBuildCommands(context, output, toolchainService, sourceMappingService, wasmBuildService);
  registerRunCommands(context, output, toolchainService, sourceMappingService, logcatService, wasmBuildService);
  registerConfigView(context, toolchainService, () => {
    sweetLineService.invalidate();
    void openTiecodeProject(compilerService, diagnostics, vscode.window.activeTextEditor?.document.uri, "reload");
  });
  registerTemplateCommands(context);
  registerTspImport(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("tiecode.reloadProject", async () => {
      await openTiecodeProject(compilerService, diagnostics, vscode.window.activeTextEditor?.document.uri, "reload");
    }),
    vscode.commands.registerCommand("tiecode.lintWorkspace", () => diagnostics.refreshWorkspace(vscode.window.activeTextEditor?.document.uri)),
    vscode.commands.registerCommand("tiecode.generateEvent", () => generateEventAtCursor(compilerService)),
    vscode.commands.registerCommand("tiecode.smartEnter", () => smartEnterAtCursor(compilerService)),
    vscode.commands.registerCommand("tiecode.scanUiClasses", () => scanUiClasses(compilerService, output)),
    vscode.commands.registerCommand("tiecode.showSyncedSource", () => showSyncedSource(compilerService)),
    vscode.commands.registerCommand("tiecode.exportTlyLayout", () => exportTlyLayout(compilerService)),
    vscode.commands.registerCommand("tiecode.applyTlyLayout", () => applyTlyLayout(compilerService)),
    vscode.workspace.onDidOpenTextDocument(document => diagnostics.schedule(document)),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (isTiecodeDocument(event.document)) {
        void compilerService.syncTextDocumentChange(event);
      }
      if (isTiecodeRelatedDocument(event.document)) {
        sweetLineService.invalidate(event.document.uri);
        diagnostics.schedule(event.document);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(document => diagnostics.refreshDocument(document)),
    vscode.workspace.onDidCloseTextDocument(document => {
      sweetLineService.invalidate(document.uri);
      diagnostics.clear(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("tiecode")) {
        sweetLineService.invalidate();
        void openTiecodeProject(compilerService, diagnostics, vscode.window.activeTextEditor?.document.uri, "reload");
      }
      if (event.affectsConfiguration("editor.tabSize")) {
        sweetLineService.invalidate();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      sweetLineService.invalidate();
      void openTiecodeProject(compilerService, diagnostics, undefined, "open");
    }),
    vscode.workspace.onDidRenameFiles(event => {
      for (const file of event.files) {
        if (isTiecodeSourceUri(file.oldUri) || isTiecodeSourceUri(file.newUri)) {
          void compilerService.notifyRename(file.oldUri, file.newUri);
        }
        if (isProjectConfigUri(file.oldUri) || isProjectConfigUri(file.newUri)) {
          void openTiecodeProject(compilerService, diagnostics, file.newUri, "reload");
        }
      }
    })
  );

  const sourceWatcher = vscode.workspace.createFileSystemWatcher("**/*.{t,tly}");
  const configWatcher = vscode.workspace.createFileSystemWatcher("**/{project.json,tiecode.project.json,lib.json}");
  context.subscriptions.push(
    sourceWatcher,
    sourceWatcher.onDidCreate(async uri => {
      const text = await readWorkspaceText(uri);
      if (uri.fsPath.toLocaleLowerCase().endsWith(".t")) {
        await compilerService.notifyCreate(uri, text);
      }
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      if (document) {
        diagnostics.schedule(document);
      }
    }),
    sourceWatcher.onDidDelete(uri => {
      if (uri.fsPath.toLocaleLowerCase().endsWith(".t")) {
        void compilerService.notifyDelete(uri);
      }
      diagnostics.clear(uri);
    }),
    sourceWatcher.onDidChange(async uri => {
      if (uri.fsPath.toLocaleLowerCase().endsWith(".t")) {
        void compilerService.notifyChange(uri, await readWorkspaceText(uri));
      }
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      if (document) {
        diagnostics.schedule(document);
      }
    }),
    configWatcher,
    configWatcher.onDidCreate(uri => {
      if (isProjectConfigUri(uri)) {
        void openTiecodeProject(compilerService, diagnostics, uri, "reload");
      }
    }),
    configWatcher.onDidChange(uri => {
      if (isProjectConfigUri(uri)) {
        void openTiecodeProject(compilerService, diagnostics, uri, "reload");
      }
    }),
    configWatcher.onDidDelete(uri => {
      if (isProjectConfigUri(uri)) {
        void openTiecodeProject(compilerService, diagnostics, uri, "reload");
      }
    })
  );

  for (const document of vscode.workspace.textDocuments) {
    diagnostics.schedule(document);
  }
  const startupTimer = setTimeout(() => {
    void openTiecodeProject(compilerService, diagnostics, undefined, "open");
  }, 500);
  context.subscriptions.push({ dispose: () => clearTimeout(startupTimer) });
}

export function deactivate(): void {}

async function readWorkspaceText(uri: vscode.Uri): Promise<string> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return "";
  }
}

function isTiecodeSourceUri(uri: vscode.Uri): boolean {
  return uri.fsPath.toLocaleLowerCase().endsWith(".t");
}
