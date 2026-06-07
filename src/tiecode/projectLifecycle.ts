import * as path from "path";
import * as vscode from "vscode";
import { TiecodeCompilerService } from "./compilerService";
import { TiecodeDiagnostics } from "./diagnostics";
import { getProjectInfo, projectKindDisplayName } from "./workspace";

type OpenReason = "open" | "reload";

export async function openTiecodeProject(
  service: TiecodeCompilerService,
  diagnostics: TiecodeDiagnostics,
  uri?: vscode.Uri,
  reason: OpenReason = "open"
): Promise<void> {
  const project = getProjectInfo(uri);
  if (!project) {
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
