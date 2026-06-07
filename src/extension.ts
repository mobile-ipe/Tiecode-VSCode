import * as vscode from "vscode";
import { registerBuildCommands } from "./tiecode/build";
import { TiecodeCompilerService } from "./tiecode/compilerService";
import { TiecodeDiagnostics } from "./tiecode/diagnostics";
import { applyTlyLayout, exportTlyLayout } from "./tiecode/layoutCommands";
import { generateEventAtCursor, registerTiecodeProviders } from "./tiecode/providers";
import { registerTemplateCommands } from "./tiecode/templates";
import { isTiecodeDocument } from "./tiecode/workspace";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("结绳");
  const compilerService = new TiecodeCompilerService(context, output);
  const diagnostics = new TiecodeDiagnostics(
    compilerService,
    vscode.languages.createDiagnosticCollection("tiecode"),
    output
  );

  context.subscriptions.push(output, diagnostics);
  registerTiecodeProviders(context, compilerService);
  registerBuildCommands(context, output);
  registerTemplateCommands(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("tiecode.reloadProject", async () => {
      await compilerService.reload(vscode.window.activeTextEditor?.document.uri);
      await diagnostics.refreshWorkspace(vscode.window.activeTextEditor?.document.uri);
      void vscode.window.showInformationMessage("结绳工程已重新加载。");
    }),
    vscode.commands.registerCommand("tiecode.lintWorkspace", () => diagnostics.refreshWorkspace(vscode.window.activeTextEditor?.document.uri)),
    vscode.commands.registerCommand("tiecode.generateEvent", () => generateEventAtCursor(compilerService)),
    vscode.commands.registerCommand("tiecode.exportTlyLayout", () => exportTlyLayout(compilerService)),
    vscode.commands.registerCommand("tiecode.applyTlyLayout", () => applyTlyLayout(compilerService)),
    vscode.workspace.onDidOpenTextDocument(document => diagnostics.schedule(document)),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (isTiecodeDocument(event.document)) {
        void compilerService.call(event.document, () => undefined);
        diagnostics.schedule(event.document);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(document => diagnostics.refreshDocument(document)),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.clear(document.uri)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("tiecode")) {
        void compilerService.reload(vscode.window.activeTextEditor?.document.uri);
      }
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.t");
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(async uri => {
      const document = await vscode.workspace.openTextDocument(uri);
      await compilerService.notifyCreate(uri, document.getText());
      diagnostics.schedule(document);
    }),
    watcher.onDidDelete(uri => {
      void compilerService.notifyDelete(uri);
      diagnostics.clear(uri);
    }),
    watcher.onDidChange(async uri => {
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      if (document) {
        diagnostics.schedule(document);
      }
    })
  );

  for (const document of vscode.workspace.textDocuments) {
    diagnostics.schedule(document);
  }
}

export function deactivate(): void {}
