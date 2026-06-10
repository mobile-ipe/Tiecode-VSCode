import * as path from "path";
import * as vscode from "vscode";
import { createProject } from "./templates";
import { ToolchainItemStatus, ToolchainService } from "./toolchain";
import { BuildMode, DefineValue, ProjectKind, TiecodeProjectConfig } from "./types";
import {
  getProjectBuildMode,
  getProjectInfo,
  getWorkspaceRoot,
  normalizeProjectKind,
  normalizeSourceVersion,
  projectKindTypeId,
  readProjectFileConfig,
  updateProjectConfig
} from "./workspace";

const CONFIG_VIEW_ID = "tiecode.configView";

interface ConfigViewState {
  hasProject: boolean;
  rootPath: string;
  kind: ProjectKind;
  appName: string;
  packageName: string;
  sourceVersion: number;
  buildMode: BuildMode;
  minSdk: number;
  targetSdk: number;
  versionCode: number;
  versionName: string;
  iconPath: string;
  toolchain: ToolchainItemStatus[];
  cxxTarget: string;
  cxxExecutableName: string;
  runCmake: boolean;
  cmakeCommand: string;
  cmakeGenerator: string;
  cmakeBuildType: string;
  cmakeBuildDirectory: string;
  htmlTitle: string;
  definesText: string;
}

interface SaveMessage {
  command: "save";
  payload: ConfigViewState;
}

interface PickIconMessage {
  command: "pickIcon";
}

interface RefreshMessage {
  command: "refresh";
}

interface RepairToolchainMessage {
  command: "repairToolchain";
}

interface CreateProjectMessage {
  command: "createProject";
  kind: ProjectKind;
}

interface ImportTspProjectMessage {
  command: "importTspProject";
}

type ConfigViewMessage = SaveMessage | PickIconMessage | RefreshMessage | RepairToolchainMessage | CreateProjectMessage | ImportTspProjectMessage;

export function registerConfigView(context: vscode.ExtensionContext, toolchain: ToolchainService, onDidSave?: () => void): void {
  const provider = new TiecodeConfigViewProvider(toolchain, onDidSave);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CONFIG_VIEW_ID, provider),
    vscode.commands.registerCommand("tiecode.openConfig", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.tiecode");
      await vscode.commands.executeCommand(`${CONFIG_VIEW_ID}.focus`);
    })
  );
}

class TiecodeConfigViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly toolchain: ToolchainService,
    private readonly onDidSave?: () => void
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(message => this.handleMessage(message as ConfigViewMessage));
    this.refresh();
  }

  refresh(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.createHtml(this.view.webview, this.createState());
  }

  private async handleMessage(message: ConfigViewMessage): Promise<void> {
    if (message.command === "refresh") {
      this.refresh();
      return;
    }
    if (message.command === "pickIcon") {
      await this.pickIcon();
      return;
    }
    if (message.command === "repairToolchain") {
      await this.repairToolchain();
      return;
    }
    if (message.command === "createProject") {
      await this.createProject(message.kind);
      return;
    }
    if (message.command === "importTspProject") {
      await vscode.commands.executeCommand("tiecode.importTspProject");
      return;
    }
    if (message.command === "save") {
      this.save(message.payload);
    }
  }

  private createState(): ConfigViewState {
    const project = getProjectInfo(vscode.window.activeTextEditor?.document.uri);
    const rootPath = project?.rootPath ?? getWorkspaceRoot() ?? "";
    const config = rootPath ? readProjectFileConfig(rootPath) : {};
    const effective = project?.config ?? config;
    const android = effective.android ?? {};
    const cxx = effective.cxx ?? {};
    const html = effective.html ?? {};
    const kind = project?.kind ?? normalizeProjectKind(effective.typeId ?? effective.classification_id ?? effective.type ?? effective.classification) ?? "android";

    return {
      hasProject: Boolean(project && rootPath),
      rootPath,
      kind,
      appName: android.appName ?? effective.name ?? effective.app_name ?? "",
      packageName: project?.packageName ?? effective.app_pkg ?? effective.packageName ?? "",
      sourceVersion: project?.sourceVersion ?? normalizeSourceVersion(effective.source_version ?? effective.sourceVersion),
      buildMode: getProjectBuildMode(effective),
      minSdk: android.minSdk ?? effective.min_sdk ?? 21,
      targetSdk: android.targetSdk ?? effective.target_sdk ?? 28,
      versionCode: android.versionCode ?? effective.version_code ?? 1,
      versionName: android.versionName ?? effective.version_name ?? "1.0",
      iconPath: android.iconPath ?? effective.icon_path ?? "",
      toolchain: project?.kind === "android" ? this.toolchain.getStatus(project).items : [],
      cxxTarget: cxx.target ?? (process.platform === "win32" ? "windows" : "linux"),
      cxxExecutableName: cxx.executableName ?? effective.name ?? "main",
      runCmake: cxx.runCmake ?? true,
      cmakeCommand: cxx.cmakeCommand ?? "cmake",
      cmakeGenerator: cxx.cmakeGenerator ?? "",
      cmakeBuildType: cxx.cmakeBuildType ?? "Debug",
      cmakeBuildDirectory: cxx.cmakeBuildDirectory ?? "${workspaceFolder}\\build\\cmake",
      htmlTitle: html.title ?? effective.name ?? effective.app_name ?? "",
      definesText: effective.macro_definitions ?? formatDefines(effective.defines ?? {})
    };
  }

  private save(payload: ConfigViewState): void {
    if (!payload.rootPath) {
      void vscode.window.showErrorMessage("没有打开结绳工作区。");
      return;
    }

    updateProjectConfig(payload.rootPath, config => applyState(config, payload));
    void vscode.window.showInformationMessage("结绳运行配置已保存。");
    this.onDidSave?.();
    this.refresh();
  }

  private async pickIcon(): Promise<void> {
    const rootPath = getWorkspaceRoot();
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: rootPath ? vscode.Uri.file(rootPath) : undefined,
      filters: {
        "Image": ["png", "jpg", "jpeg", "webp", "ico"]
      }
    });
    const file = picked?.[0]?.fsPath;
    if (!file || !this.view) {
      return;
    }
    const iconPath = rootPath ? toProjectRelativePath(rootPath, file) : file;
    void this.view.webview.postMessage({ command: "setIconPath", value: iconPath });
  }

  private async repairToolchain(): Promise<void> {
    const project = getProjectInfo(vscode.window.activeTextEditor?.document.uri, "android");
    if (!project) {
      void vscode.window.showErrorMessage("没有打开结绳安卓工程。");
      return;
    }

    await this.toolchain.repairAndroidToolchain(project);
    this.refresh();
  }

  private async createProject(kind: ProjectKind): Promise<void> {
    await createProject(kind, { forcePickBaseRoot: true, openAfterCreate: true });
  }

  private createHtml(webview: vscode.Webview, state: ConfigViewState): string {
    const nonce = createNonce();
    const stateJson = JSON.stringify(state).replace(/</g, "\\u003c");
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
      padding: 12px;
    }
    form {
      display: grid;
      gap: 14px;
    }
    section {
      display: grid;
      gap: 8px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      padding-top: 12px;
    }
    section:first-of-type {
      border-top: 0;
      padding-top: 0;
    }
    h2 {
      font-size: 12px;
      font-weight: 600;
      margin: 0;
      color: var(--vscode-sideBarTitle-foreground);
    }
    label {
      display: grid;
      gap: 4px;
    }
    input,
    select,
    textarea {
      width: 100%;
      box-sizing: border-box;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      padding: 5px 7px;
      font: inherit;
    }
    textarea {
      min-height: 88px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family);
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .check input {
      width: auto;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      position: sticky;
      bottom: 0;
      padding-top: 8px;
      background: var(--vscode-sideBar-background);
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 3px;
      padding: 6px 8px;
      font: inherit;
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
      display: grid;
      gap: 10px;
    }
    .empty-actions {
      display: grid;
      gap: 8px;
    }
    .toolchain {
      display: grid;
      gap: 6px;
    }
    .toolchain-item {
      display: grid;
      gap: 2px;
      border-left: 2px solid var(--vscode-testing-iconUnset);
      padding-left: 8px;
    }
    .toolchain-item.ready {
      border-left-color: var(--vscode-testing-iconPassed);
    }
    .toolchain-name {
      font-weight: 600;
    }
    .toolchain-detail {
      color: var(--vscode-descriptionForeground);
      overflow-wrap: anywhere;
    }
    [hidden] {
      display: none;
    }
  </style>
</head>
<body>
  <form id="config-form">
    <section>
      <h2>工程</h2>
      <label>类型
        <select id="kind">
          <option value="android">安卓</option>
          <option value="cxx">CXX</option>
          <option value="html">网页</option>
        </select>
      </label>
      <label>名称
        <input id="appName">
      </label>
      <label>包名
        <input id="packageName">
      </label>
      <label>源代码版本
        <select id="sourceVersion">
          <option value="40">4.0</option>
          <option value="46">4.6</option>
          <option value="47">4.7</option>
        </select>
      </label>
      <label>打包模式
        <select id="buildMode">
          <option value="debug">调试包</option>
          <option value="release">正式包</option>
        </select>
      </label>
    </section>
    <section id="android-section">
      <h2>安卓</h2>
      <div class="row">
        <label>minSdk
          <input id="minSdk" type="number" min="1">
        </label>
        <label>targetSdk
          <input id="targetSdk" type="number" min="1">
        </label>
      </div>
      <div class="row">
        <label>versionCode
          <input id="versionCode" type="number" min="1">
        </label>
        <label>versionName
          <input id="versionName">
        </label>
      </div>
      <label>图标
        <input id="iconPath">
      </label>
      <button class="secondary" id="pickIcon" type="button">选择图标</button>
    </section>
    <section id="toolchain-section">
      <h2>环境</h2>
      <div class="toolchain" id="toolchain"></div>
      <button class="secondary" id="repairToolchain" type="button">修复环境</button>
    </section>
    <section id="cxx-section">
      <h2>CXX</h2>
      <label>目标
        <select id="cxxTarget">
          <option value="windows">Windows</option>
          <option value="linux">Linux</option>
        </select>
      </label>
      <label>可执行文件
        <input id="cxxExecutableName">
      </label>
      <label class="check"><input id="runCmake" type="checkbox">运行 CMake</label>
      <label>CMake
        <input id="cmakeCommand">
      </label>
      <label>Generator
        <input id="cmakeGenerator">
      </label>
      <label>Build Type
        <input id="cmakeBuildType">
      </label>
      <label>构建目录
        <input id="cmakeBuildDirectory">
      </label>
    </section>
    <section id="html-section">
      <h2>网页</h2>
      <label>标题
        <input id="htmlTitle">
      </label>
    </section>
    <section>
      <h2>宏定义</h2>
      <textarea id="definesText" spellcheck="false"></textarea>
    </section>
    <div class="actions">
      <button id="save" type="submit">保存</button>
      <button class="secondary" id="refresh" type="button">刷新</button>
    </div>
  </form>
  <div class="empty" id="empty" hidden>
    <div>没有打开结绳工作区。</div>
    <div class="empty-actions">
      <button id="createAndroid" type="button">创建安卓工程</button>
      <button class="secondary" id="createCxx" type="button">创建 CXX 工程</button>
      <button class="secondary" id="createHtml" type="button">创建网页工程</button>
      <button class="secondary" id="importTsp" type="button">导入 TSP 工程包</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${stateJson};
    const ids = [
      "kind", "appName", "packageName", "sourceVersion", "buildMode", "minSdk", "targetSdk",
      "versionCode", "versionName", "iconPath", "cxxTarget", "cxxExecutableName",
      "runCmake", "cmakeCommand", "cmakeGenerator", "cmakeBuildType",
      "cmakeBuildDirectory", "htmlTitle", "definesText"
    ];
    const fields = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    const form = document.getElementById("config-form");
    const empty = document.getElementById("empty");
    const toolchain = document.getElementById("toolchain");

    function fill() {
      form.hidden = !state.hasProject;
      empty.hidden = state.hasProject;
      for (const id of ids) {
        if (!fields[id]) {
          continue;
        }
        if (fields[id].type === "checkbox") {
          fields[id].checked = Boolean(state[id]);
        } else {
          fields[id].value = state[id] ?? "";
        }
      }
      updateSections();
      renderToolchain();
    }

    function collect() {
      const payload = { ...state };
      for (const id of ids) {
        if (fields[id].type === "checkbox") {
          payload[id] = fields[id].checked;
        } else if (fields[id].type === "number") {
          payload[id] = Number(fields[id].value);
        } else {
          payload[id] = fields[id].value;
        }
      }
      return payload;
    }

    function updateSections() {
      const kind = fields.kind.value;
      document.getElementById("android-section").hidden = kind !== "android";
      document.getElementById("toolchain-section").hidden = kind !== "android";
      document.getElementById("cxx-section").hidden = kind !== "cxx";
      document.getElementById("html-section").hidden = kind !== "html";
    }

    function renderToolchain() {
      toolchain.textContent = "";
      for (const item of state.toolchain || []) {
        const root = document.createElement("div");
        root.className = "toolchain-item" + (item.ready ? " ready" : "");
        const name = document.createElement("div");
        name.className = "toolchain-name";
        name.textContent = item.ready ? item.name + " 已就绪" : item.name + " 未就绪";
        const detail = document.createElement("div");
        detail.className = "toolchain-detail";
        detail.textContent = item.detail;
        root.append(name, detail);
        toolchain.append(root);
      }
    }

    fields.kind.addEventListener("change", updateSections);
    document.getElementById("pickIcon").addEventListener("click", () => vscode.postMessage({ command: "pickIcon" }));
    document.getElementById("repairToolchain").addEventListener("click", () => vscode.postMessage({ command: "repairToolchain" }));
    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ command: "refresh" }));
    document.getElementById("createAndroid").addEventListener("click", () => vscode.postMessage({ command: "createProject", kind: "android" }));
    document.getElementById("createCxx").addEventListener("click", () => vscode.postMessage({ command: "createProject", kind: "cxx" }));
    document.getElementById("createHtml").addEventListener("click", () => vscode.postMessage({ command: "createProject", kind: "html" }));
    document.getElementById("importTsp").addEventListener("click", () => vscode.postMessage({ command: "importTspProject" }));
    form.addEventListener("submit", event => {
      event.preventDefault();
      vscode.postMessage({ command: "save", payload: collect() });
    });
    window.addEventListener("message", event => {
      if (event.data?.command === "setIconPath") {
        fields.iconPath.value = event.data.value;
      }
    });
    fill();
  </script>
</body>
</html>`;
  }
}

function applyState(config: TiecodeProjectConfig, payload: ConfigViewState): void {
  const kind = normalizeProjectKind(payload.kind) ?? "android";
  config.typeId = projectKindTypeId(kind);
  config.app_name = payload.appName;
  config.source_version = normalizeSourceVersion(payload.sourceVersion);
  config.buildMode = payload.buildMode === "release" ? "release" : "debug";
  config.macro_definitions = payload.definesText;
  delete (config as Record<string, unknown>).compiler;
  delete config.type;
  delete config.name;
  delete config.packageName;
  delete config.sourceVersion;
  delete config.defines;
  delete config.classification_id;
  delete config.classification;
  delete config.project_name;
  delete config.project_kind;
  delete config.android;

  if (kind !== "android") {
    delete config.app_pkg;
    delete config.min_sdk;
    delete config.target_sdk;
    delete config.version_code;
    delete config.version_name;
    delete config.icon_path;
  }
  if (kind !== "cxx") {
    delete config.cxx;
  }
  if (kind !== "html") {
    delete config.html;
  }

  if (kind === "android") {
    config.app_pkg = payload.packageName;
    config.min_sdk = toPositiveNumber(payload.minSdk, 21);
    config.target_sdk = toPositiveNumber(payload.targetSdk, 28);
    config.version_code = toPositiveNumber(payload.versionCode, 1);
    config.version_name = payload.versionName || "1.0";
    config.icon_path = payload.iconPath;
  }

  if (kind === "cxx") {
    config.cxx = {
      ...(config.cxx ?? {}),
      target: payload.cxxTarget === "linux" ? "linux" : "windows",
      executableName: payload.cxxExecutableName || "main",
      runCmake: payload.runCmake,
      cmakeCommand: payload.cmakeCommand || "cmake",
      cmakeGenerator: payload.cmakeGenerator || undefined,
      cmakeBuildType: payload.cmakeBuildType || "Debug",
      cmakeBuildDirectory: payload.cmakeBuildDirectory || "${workspaceFolder}\\build\\cmake"
    };
    delete (config.cxx as Record<string, unknown>).useCmake;
  }

  if (kind === "html") {
    config.html = {
      ...(config.html ?? {}),
      title: payload.htmlTitle || payload.appName
    };
  }
}

function formatDefines(defines: Record<string, DefineValue>): string {
  return Object.entries(defines)
    .map(([name, value]) => value === null ? name : `${name}=${formatDefineValue(value)}`)
    .join("\n");
}

function formatDefineValue(value: Exclude<DefineValue, null>): string {
  if (value === true) {
    return "真";
  }
  if (value === false) {
    return "假";
  }
  return String(value);
}

function toPositiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function toProjectRelativePath(rootPath: string, filePath: string): string {
  const relative = path.relative(rootPath, filePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return filePath;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += chars[Math.floor(Math.random() * chars.length)];
  }
  return nonce;
}
