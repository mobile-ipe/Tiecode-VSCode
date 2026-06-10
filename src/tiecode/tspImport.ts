import AdmZip from "adm-zip";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { PROJECT_CONFIG_FILE, TiecodeProjectConfig } from "./types";
import { ensureDirectory } from "./workspace";

const TSP_EDITOR_VIEW_TYPE = "tiecode.tspProject";
const IMPORT_DIRECTORY_CONFIG = "import.directory";
const DEFAULT_IMPORT_FOLDER = "TiecodeProjects";

interface TspImportResult {
  projectRoot: string;
}

interface TspProjectPackage {
  zip: AdmZip;
  projectName: string;
  stripPrefix: string;
}

class TspCustomDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {}
}

class TspImportEditorProvider implements vscode.CustomReadonlyEditorProvider<TspCustomDocument> {
  async openCustomDocument(uri: vscode.Uri): Promise<TspCustomDocument> {
    return new TspCustomDocument(uri);
  }

  async resolveCustomEditor(document: TspCustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true };
    let importing = false;

    const runImport = async (): Promise<void> => {
      if (importing) {
        return;
      }
      importing = true;
      panel.webview.html = renderImportHtml("正在导入结绳工程包...", document.uri.fsPath, true);
      try {
        const result = await importTspProject(document.uri, { openAfterImport: true, showSuccess: true });
        if (!result) {
          panel.webview.html = renderImportHtml("未完成导入。", document.uri.fsPath, false);
        }
      } finally {
        importing = false;
      }
    };

    const messageSubscription = panel.webview.onDidReceiveMessage(message => {
      if (message?.command === "import") {
        void runImport();
      }
    });
    panel.onDidDispose(() => messageSubscription.dispose());

    await runImport();
  }
}

interface TspImportOptions {
  openAfterImport?: boolean;
  showSuccess?: boolean;
}

export function registerTspImport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tiecode.importTspProject", uri => importTspProject(toUri(uri), { openAfterImport: true, showSuccess: true })),
    vscode.window.registerCustomEditorProvider(TSP_EDITOR_VIEW_TYPE, new TspImportEditorProvider(), {
      supportsMultipleEditorsPerDocument: false
    })
  );
}

async function importTspProject(
  sourceUri?: vscode.Uri,
  options: TspImportOptions = {}
): Promise<TspImportResult | undefined> {
  const uri = sourceUri ?? await pickTspFile();
  if (!uri) {
    return undefined;
  }

  if (uri.scheme !== "file") {
    void vscode.window.showErrorMessage("当前只支持导入本地 TSP 工程包。");
    return undefined;
  }

  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "正在导入结绳工程包",
        cancellable: false
      },
      async () => {
        const projectPackage = readTspProjectPackage(uri.fsPath);
        const importRoot = await resolveImportRoot();
        if (!importRoot) {
          return undefined;
        }

        const targetRoot = await resolveTargetRoot(importRoot, projectPackage.projectName);
        if (!targetRoot) {
          return undefined;
        }

        extractProjectPackage(projectPackage, targetRoot);
        if (options.showSuccess) {
          void vscode.window.showInformationMessage(`结绳工程已导入: ${targetRoot}`);
        }
        if (options.openAfterImport) {
          await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(targetRoot), false);
        }
        return { projectRoot: targetRoot };
      }
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`导入 TSP 工程包失败: ${String(error instanceof Error ? error.message : error)}`);
    return undefined;
  }
}

async function pickTspFile(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: "选择 TSP 工程包",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      "TSP 工程包": ["tsp"]
    }
  });
  return picked?.[0];
}

async function resolveImportRoot(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration("tiecode").get<string>(IMPORT_DIRECTORY_CONFIG, "").trim();
  if (configured) {
    const resolved = expandImportDirectory(configured);
    ensureDirectory(resolved);
    return resolved;
  }

  const defaultRoot = path.join(os.homedir(), DEFAULT_IMPORT_FOLDER);
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "导入到默认目录",
        description: defaultRoot,
        value: defaultRoot
      },
      {
        label: "选择存放目录",
        description: "工程会解压到该目录下的同名子目录",
        value: ""
      }
    ],
    {
      title: "选择结绳工程导入位置",
      placeHolder: "选择用于存放导入工程的父目录，后续可通过 tiecode.import.directory 修改"
    }
  );
  if (!choice) {
    return undefined;
  }

  let selectedRoot = choice.value;
  if (!selectedRoot) {
    const picked = await vscode.window.showOpenDialog({
      title: "选择结绳工程存放父目录",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false
    });
    selectedRoot = picked?.[0]?.fsPath ?? "";
  }
  if (!selectedRoot) {
    return undefined;
  }

  ensureDirectory(selectedRoot);
  await vscode.workspace.getConfiguration("tiecode").update(IMPORT_DIRECTORY_CONFIG, selectedRoot, vscode.ConfigurationTarget.Global);
  return selectedRoot;
}

async function resolveTargetRoot(importRoot: string, projectName: string): Promise<string | undefined> {
  const safeName = sanitizeFileName(projectName) || "TiecodeProject";
  let targetRoot = path.join(importRoot, safeName);

  while (fs.existsSync(targetRoot) && fs.readdirSync(targetRoot).length > 0) {
    const answer = await vscode.window.showWarningMessage(
      `工程 ${path.basename(targetRoot)} 已存在，是否覆盖？`,
      "覆盖",
      "改名导入",
      "选择存放目录",
      "取消"
    );

    if (answer === "覆盖") {
      fs.rmSync(targetRoot, { recursive: true, force: true });
      return targetRoot;
    }
    if (answer === "改名导入") {
      targetRoot = nextAvailableDirectory(importRoot, safeName);
      return targetRoot;
    }
    if (answer === "选择存放目录") {
      const picked = await vscode.window.showOpenDialog({
        title: "选择结绳工程存放父目录",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false
      });
      const pickedRoot = picked?.[0]?.fsPath;
      if (!pickedRoot) {
        return undefined;
      }
      importRoot = pickedRoot;
      targetRoot = path.join(importRoot, safeName);
      continue;
    }
    return undefined;
  }

  return targetRoot;
}

function readTspProjectPackage(filePath: string): TspProjectPackage {
  const zip = new AdmZip(filePath);
  const projectEntry = findProjectConfigEntry(zip);
  if (!projectEntry) {
    throw new Error("工程包中未找到 project.json。");
  }

  const configText = projectEntry.getData().toString("utf8").replace(/^\uFEFF/, "");
  const config = JSON.parse(configText) as TiecodeProjectConfig;
  return {
    zip,
    projectName: readProjectName(config) || path.basename(filePath, path.extname(filePath)),
    stripPrefix: readStripPrefix(projectEntry.entryName)
  };
}

function findProjectConfigEntry(zip: AdmZip): AdmZip.IZipEntry | undefined {
  const entries = zip.getEntries().filter(entry => {
    if (entry.isDirectory) {
      return false;
    }
    const entryPath = normalizeZipPath(entry.entryName);
    return entryPath === PROJECT_CONFIG_FILE || entryPath.endsWith(`/${PROJECT_CONFIG_FILE}`);
  });
  return entries.find(entry => normalizeZipPath(entry.entryName) === PROJECT_CONFIG_FILE) ?? entries[0];
}

function extractProjectPackage(projectPackage: TspProjectPackage, targetRoot: string): void {
  ensureDirectory(targetRoot);
  const rootPath = path.resolve(targetRoot);

  for (const entry of projectPackage.zip.getEntries()) {
    const entryPath = normalizeZipPath(entry.entryName);
    if (!entryPath || !isUnderStripPrefix(entryPath, projectPackage.stripPrefix)) {
      continue;
    }

    const relativePath = removeStripPrefix(entryPath, projectPackage.stripPrefix);
    if (!relativePath) {
      continue;
    }

    const targetPath = path.resolve(rootPath, ...relativePath.split("/"));
    if (!isInsideOrEqual(targetPath, rootPath)) {
      throw new Error(`工程包包含非法路径: ${entry.entryName}`);
    }

    if (entry.isDirectory) {
      ensureDirectory(targetPath);
      continue;
    }

    ensureDirectory(path.dirname(targetPath));
    fs.writeFileSync(targetPath, entry.getData());
  }
}

function normalizeZipPath(entryName: string): string {
  if (entryName.includes("\0") || entryName.startsWith("/") || /^[A-Za-z]:/.test(entryName)) {
    throw new Error(`工程包包含非法路径: ${entryName}`);
  }

  const normalized = entryName.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.includes("..")) {
    throw new Error(`工程包包含非法路径: ${entryName}`);
  }
  return parts.join("/");
}

function readStripPrefix(entryName: string): string {
  const normalized = normalizeZipPath(entryName);
  const directory = path.posix.dirname(normalized);
  return directory === "." ? "" : `${directory}/`;
}

function isUnderStripPrefix(entryPath: string, stripPrefix: string): boolean {
  return !stripPrefix || entryPath === stripPrefix.slice(0, -1) || entryPath.startsWith(stripPrefix);
}

function removeStripPrefix(entryPath: string, stripPrefix: string): string {
  return stripPrefix && entryPath.startsWith(stripPrefix) ? entryPath.slice(stripPrefix.length) : entryPath;
}

function readProjectName(config: TiecodeProjectConfig): string | undefined {
  return config.project_name ?? config.app_name ?? config.name ?? config.android?.appName;
}

function nextAvailableDirectory(importRoot: string, baseName: string): string {
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(importRoot, `${baseName}_${index}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(importRoot, `${baseName}_${Date.now()}`);
}

function expandImportDirectory(value: string): string {
  const home = os.homedir();
  let expanded = value.replace(/\$\{userHome\}/g, home);
  if (expanded === "~") {
    expanded = home;
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(home, expanded.slice(2));
  }
  return path.isAbsolute(expanded) ? expanded : path.join(home, expanded);
}

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[<>:"/\\|?*]+/g, "_");
}

function isInsideOrEqual(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toUri(value: unknown): vscode.Uri | undefined {
  return value instanceof vscode.Uri ? value : undefined;
}

function renderImportHtml(message: string, filePath: string, busy: boolean): string {
  const nonce = createNonce();
  const disabled = busy ? "disabled" : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      box-sizing: border-box;
      margin: 0;
      padding: 28px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    .title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .path {
      color: var(--vscode-descriptionForeground);
      word-break: break-all;
      margin-bottom: 20px;
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      padding: 6px 14px;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      cursor: default;
      opacity: 0.65;
    }
  </style>
</head>
<body>
  <div class="title">${escapeHtml(message)}</div>
  <div class="path">${escapeHtml(filePath)}</div>
  <button id="import" ${disabled}>重新导入</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("import").addEventListener("click", () => vscode.postMessage({ command: "import" }));
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    if (char === "&") {
      return "&amp;";
    }
    if (char === "<") {
      return "&lt;";
    }
    if (char === ">") {
      return "&gt;";
    }
    if (char === "\"") {
      return "&quot;";
    }
    return "&#39;";
  });
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
