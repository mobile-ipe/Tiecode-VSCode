import * as path from "path";
import * as vscode from "vscode";
import { TiecodeCompilerService } from "./compilerService";
import { TiecodeDiagnostics } from "./diagnostics";
import { ProjectKind } from "./types";
import { createProjectConfig, getProjectInfo, getWorkspaceRoot, hasProjectConfig, looksLikeTiecodeWorkspace, projectKindDisplayName, writeProjectConfig } from "./workspace";

type OpenReason = "open" | "reload";

export async function openTiecodeProject(
  service: TiecodeCompilerService,
  diagnostics: TiecodeDiagnostics,
  uri?: vscode.Uri,
  reason: OpenReason = "open"
): Promise<void> {
  const project = getProjectInfo(uri);
  if (!project) {
    await promptCreateProjectInfo(service, diagnostics, uri);
    return;
  }

  const projectName = path.basename(project.rootPath);
  const projectType = projectKindDisplayName(project.kind);
  const title = reason === "reload" ? `正在重新加载${projectType}` : `正在打开${projectType}`;
  const targetUri = uri ?? vscode.Uri.file(project.rootPath);

  try {
    const session = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false
    }, async progress => {
      progress.report({ message: projectName });
      const loaded = await service.reload(targetUri);
      await diagnostics.refreshWorkspace(targetUri);
      return loaded;
    });

    const sourceCount = session?.project.sourceFiles.length ?? project.sourceFiles.length;
    const action = reason === "reload" ? "已重新加载" : "已打开";
    void vscode.window.showInformationMessage(`${action}${projectType}: ${projectName}，源文件 ${sourceCount} 个`);
  } catch (error) {
    const action = reason === "reload" ? "重新加载" : "打开";
    void vscode.window.showErrorMessage(`${action}${projectType}失败: ${String(error instanceof Error ? error.message : error)}`);
  }
}

async function promptCreateProjectInfo(
  service: TiecodeCompilerService,
  diagnostics: TiecodeDiagnostics,
  uri?: vscode.Uri
): Promise<void> {
  const rootPath = getWorkspaceRoot(uri);
  if (!rootPath || hasProjectConfig(rootPath) || !looksLikeTiecodeWorkspace(rootPath)) {
    return;
  }

  const choices = new Map<string, ProjectKind>([
    ["创建安卓工程信息", "android"],
    ["创建 CXX 工程信息", "cxx"],
    ["创建网页工程信息", "html"]
  ]);
  const picked = await vscode.window.showWarningMessage(
    "当前工作区缺少 project.json，不能作为结绳工程打开。请选择工程类型创建工程信息。",
    { modal: true },
    ...choices.keys()
  );
  const kind = picked ? choices.get(picked) : undefined;
  if (!kind) {
    return;
  }

  try {
    writeProjectConfig(rootPath, createProjectConfig(kind, path.basename(rootPath)));
  } catch (error) {
    void vscode.window.showErrorMessage(`创建结绳工程信息失败: ${String(error instanceof Error ? error.message : error)}`);
    return;
  }

  void vscode.window.showInformationMessage(`已创建 project.json: ${projectKindDisplayName(kind)}`);
  await openTiecodeProject(service, diagnostics, uri, "reload");
}
