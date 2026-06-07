import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { BuildRequest, PlatformName, ProjectInfo, ProjectKind } from "./types";
import { ensureDirectory, getProjectInfo } from "./workspace";

export function registerBuildCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tiecode.buildAndroid", () => buildProject({ kind: "android", platformName: "android" }, output)),
    vscode.commands.registerCommand("tiecode.buildCxx", () => buildProject({ kind: "cxx" }, output)),
    vscode.commands.registerCommand("tiecode.buildHtml", () => buildProject({ kind: "html", platformName: "html" }, output))
  );
}

export async function buildProject(request: BuildRequest, output: vscode.OutputChannel): Promise<void> {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const project = getProjectInfo(uri, request.kind);
  if (!project) {
    void vscode.window.showErrorMessage("没有打开结绳工作区。");
    return;
  }

  if (!fs.existsSync(project.compiler.tiecPath)) {
    void vscode.window.showErrorMessage(`找不到 tiec: ${project.compiler.tiecPath}`);
    return;
  }

  const buildProjectInfo = { ...project, platformName: request.platformName ?? project.platformName };
  buildProjectInfo.platformNumber = platformNumber(buildProjectInfo.platformName);
  ensureDirectory(buildProjectInfo.outputDir);

  const args = createTiecArgs(buildProjectInfo);
  output.show(true);
  output.appendLine(`> ${project.compiler.tiecPath} ${args.map(quoteArg).join(" ")}`);

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "正在构建结绳工程",
    cancellable: false
  }, async () => {
    try {
      await runProcess(project.compiler.tiecPath, args, project.rootPath, output);
      void vscode.window.showInformationMessage(`结绳构建完成: ${buildProjectInfo.outputDir}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`结绳构建失败: ${String(error)}`);
    }
  });
}

function createTiecArgs(project: ProjectInfo): string[] {
  const args = [
    "--output",
    project.outputDir,
    "--package",
    project.packageName,
    "--source",
    String(project.sourceVersion),
    "--debug",
    "--hard-mode",
    "--enable-toplevel-stmt",
    "--platform",
    project.platformName,
    "--line-map",
    project.lineMapPath
  ];

  if (project.kind === "android") {
    const androidConfigPath = writeAndroidAppConfig(project);
    args.push("--android.app.config", androidConfigPath);
    const androidConfig = project.config.android ?? {};
    const useGradle = androidConfig.gradle ?? vscode.workspace.getConfiguration("tiecode").get<boolean>("android.gradle") ?? true;
    if (useGradle) {
      args.push("--android.gradle");
    }
    const foundationLibPath = androidConfig.foundationLibPath ?? path.dirname(project.stdlibSourceRoot ?? "");
    if (foundationLibPath) {
      args.push("--android.legacy.lib.path", foundationLibPath);
    }
  }

  for (const sourceRoot of project.sourceRoots) {
    args.push("--dir", sourceRoot);
  }

  return args;
}

function writeAndroidAppConfig(project: ProjectInfo): string {
  const android = project.config.android ?? {};
  const appConfig = {
    appName: android.appName ?? project.config.name ?? "我的应用",
    appIcon: android.iconPath ?? "",
    minSdk: android.minSdk ?? 21,
    targetSdk: android.targetSdk ?? 28,
    versionCode: android.versionCode ?? 1,
    versionName: android.versionName ?? "1.0"
  };
  const configPath = path.join(project.outputDir, "android-app-config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(appConfig, null, 2)}\n`, "utf8");
  return configPath;
}

function runProcess(command: string, args: string[], cwd: string, output: vscode.OutputChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, shell: false });
    child.stdout.on("data", data => output.append(data.toString()));
    child.stderr.on("data", data => output.append(data.toString()));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tiec 退出码 ${code ?? "unknown"}`));
      }
    });
  });
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, "\\\"")}"` : value;
}

function platformNumber(platformName: PlatformName): number {
  switch (platformName) {
    case "android":
      return 1;
    case "linux":
      return 3;
    case "windows":
      return 4;
    case "html":
      return 7;
  }
}

export function buildKindForCommand(command: string): ProjectKind | undefined {
  if (command.endsWith("Android")) {
    return "android";
  }
  if (command.endsWith("Cxx")) {
    return "cxx";
  }
  if (command.endsWith("Html")) {
    return "html";
  }
  return undefined;
}
