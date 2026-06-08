import * as cp from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import * as vscode from "vscode";
import { ProjectInfo } from "./types";
import { ensureDirectory } from "./workspace";

export interface ToolchainItemStatus {
  id: "java" | "androidSdk" | "adb" | "gradle";
  name: string;
  ready: boolean;
  detail: string;
}

export interface ToolchainStatus {
  items: ToolchainItemStatus[];
}

export interface AndroidToolchain {
  env: NodeJS.ProcessEnv;
  adbPath: string;
}

interface ToolchainPaths {
  javaHome?: string;
  javaPath?: string;
  androidSdkRoot?: string;
  adbPath?: string;
  gradleWrapper?: string;
}

const ANDROID_REPOSITORY_XML = "https://dl.google.com/android/repository/repository2-1.xml";
const TEMURIN_JDK_17_WINDOWS = "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse";

export class ToolchainService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  getStatus(project?: ProjectInfo): ToolchainStatus {
    const paths = this.detect(project);
    return {
      items: [
        {
          id: "java",
          name: "Java",
          ready: Boolean(paths.javaPath),
          detail: paths.javaPath ?? "未找到，将使用内置修复安装 JDK 17"
        },
        {
          id: "androidSdk",
          name: "Android SDK",
          ready: Boolean(paths.androidSdkRoot),
          detail: paths.androidSdkRoot ?? "未找到，将安装到 VS Code 全局存储"
        },
        {
          id: "adb",
          name: "adb",
          ready: Boolean(paths.adbPath),
          detail: paths.adbPath ?? "未找到，将随 Android SDK platform-tools 安装"
        },
        {
          id: "gradle",
          name: "Gradle",
          ready: true,
          detail: paths.gradleWrapper ?? "由生成的 Gradle Wrapper 自动下载"
        }
      ]
    };
  }

  async prepareAndroidToolchain(project: ProjectInfo): Promise<AndroidToolchain> {
    await this.repairAndroidToolchain(project, false);
    const paths = this.detect(project);
    if (!paths.javaPath) {
      throw new Error("未找到 Java，自动修复未完成。");
    }
    if (!paths.androidSdkRoot) {
      throw new Error("未找到 Android SDK，自动修复未完成。");
    }
    if (!paths.adbPath) {
      throw new Error("未找到 adb，自动修复未完成。");
    }

    return {
      env: this.createAndroidEnv(paths),
      adbPath: paths.adbPath
    };
  }

  async repairAndroidToolchain(project: ProjectInfo, showDoneMessage = true): Promise<void> {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "正在检查结绳安卓工具链",
      cancellable: false
    }, async progress => {
      let paths = this.detect(project);
      if (!paths.javaPath) {
        progress.report({ message: "安装 JDK 17" });
        await this.installJdk17();
      }

      paths = this.detect(project);
      if (!paths.androidSdkRoot || !paths.adbPath) {
        progress.report({ message: "安装 Android SDK platform-tools" });
        await this.installAndroidSdk(project);
      }
    });

    if (showDoneMessage) {
      void vscode.window.showInformationMessage("结绳安卓工具链检查完成。");
    }
  }

  private detect(project?: ProjectInfo): ToolchainPaths {
    const javaHome = this.findJavaHome();
    const androidSdkRoot = this.findAndroidSdkRoot();
    return {
      javaHome,
      javaPath: javaHome ? this.javaPath(javaHome) : findExecutable("java"),
      androidSdkRoot,
      adbPath: androidSdkRoot ? this.adbPath(androidSdkRoot) : findExecutable("adb"),
      gradleWrapper: project ? this.gradleWrapperPath(project.outputDir) : undefined
    };
  }

  private findJavaHome(): string | undefined {
    const candidates = [
      process.env.JAVA_HOME,
      path.join(this.toolchainsRoot(), "jdk")
    ].filter(isString);

    for (const candidate of candidates) {
      const javaPath = this.javaPath(candidate);
      if (fs.existsSync(javaPath)) {
        return candidate;
      }
    }
    return undefined;
  }

  private findAndroidSdkRoot(): string | undefined {
    const candidates = [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      path.join(this.toolchainsRoot(), "android-sdk")
    ].filter(isString);

    for (const candidate of candidates) {
      if (fs.existsSync(this.adbPath(candidate)) || fs.existsSync(path.join(candidate, "platforms"))) {
        return candidate;
      }
    }
    return undefined;
  }

  private async installJdk17(): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("当前自动安装 JDK 仅支持 Windows。");
    }

    const targetRoot = path.join(this.toolchainsRoot(), "jdk");
    if (fs.existsSync(this.javaPath(targetRoot))) {
      return;
    }

    const archivePath = path.join(this.downloadsRoot(), "temurin-jdk-17.zip");
    const extractRoot = path.join(this.downloadsRoot(), "temurin-jdk-17");
    await downloadFile(TEMURIN_JDK_17_WINDOWS, archivePath, this.output);
    await expandZip(archivePath, extractRoot);
    const javaPath = findFiles(extractRoot, file => path.basename(file).toLocaleLowerCase() === "java.exe")[0];
    if (!javaPath) {
      throw new Error("JDK 下载后未找到 java.exe。");
    }

    const javaHome = path.dirname(path.dirname(javaPath));
    replaceDirectory(javaHome, targetRoot);
  }

  private async installAndroidSdk(project: ProjectInfo): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("当前自动安装 Android SDK 仅支持 Windows。");
    }

    const sdkRoot = path.join(this.toolchainsRoot(), "android-sdk");
    const cmdlineRoot = path.join(sdkRoot, "cmdline-tools", "latest");
    const sdkManager = path.join(cmdlineRoot, "bin", "sdkmanager.bat");
    if (!fs.existsSync(sdkManager)) {
      const archiveUrl = await resolveAndroidCommandLineToolsUrl();
      const archivePath = path.join(this.downloadsRoot(), "android-commandlinetools.zip");
      const extractRoot = path.join(this.downloadsRoot(), "android-commandlinetools");
      await downloadFile(archiveUrl, archivePath, this.output);
      await expandZip(archivePath, extractRoot);
      const binPath = findFiles(extractRoot, file => path.basename(file).toLocaleLowerCase() === "sdkmanager.bat")[0];
      if (!binPath) {
        throw new Error("Android command line tools 下载后未找到 sdkmanager.bat。");
      }
      replaceDirectory(path.dirname(path.dirname(binPath)), cmdlineRoot);
    }

    const paths = this.detect(project);
    const env = this.createAndroidEnv({
      ...paths,
      androidSdkRoot: sdkRoot
    });
    const targetSdk = project.config.android?.targetSdk ?? project.config.target_sdk ?? 28;
    await runToolWithOutput(sdkManager, [`--sdk_root=${sdkRoot}`, "--licenses"], sdkRoot, env, this.output, "y\n".repeat(100));
    await runToolWithOutput(sdkManager, [`--sdk_root=${sdkRoot}`, "platform-tools", `platforms;android-${targetSdk}`], sdkRoot, env, this.output, "y\n".repeat(20));
    await runToolWithOutput(sdkManager, [`--sdk_root=${sdkRoot}`, "--licenses"], sdkRoot, env, this.output, "y\n".repeat(100));
  }

  private createAndroidEnv(paths: ToolchainPaths): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (paths.javaHome) {
      env.JAVA_HOME = paths.javaHome;
    }
    if (paths.androidSdkRoot) {
      env.ANDROID_HOME = paths.androidSdkRoot;
      env.ANDROID_SDK_ROOT = paths.androidSdkRoot;
    }

    const additions = [
      paths.javaHome ? path.join(paths.javaHome, "bin") : undefined,
      paths.androidSdkRoot ? path.join(paths.androidSdkRoot, "platform-tools") : undefined,
      paths.androidSdkRoot ? path.join(paths.androidSdkRoot, "cmdline-tools", "latest", "bin") : undefined
    ].filter(isString);
    env.PATH = [...additions, env.PATH ?? ""].join(path.delimiter);
    return env;
  }

  private toolchainsRoot(): string {
    const root = path.join(this.context.globalStorageUri.fsPath, "toolchains");
    ensureDirectory(root);
    return root;
  }

  private downloadsRoot(): string {
    const root = path.join(this.context.globalStorageUri.fsPath, "downloads");
    ensureDirectory(root);
    return root;
  }

  private javaPath(javaHome: string): string {
    return process.platform === "win32" ? path.join(javaHome, "bin", "java.exe") : path.join(javaHome, "bin", "java");
  }

  private adbPath(sdkRoot: string): string {
    return process.platform === "win32" ? path.join(sdkRoot, "platform-tools", "adb.exe") : path.join(sdkRoot, "platform-tools", "adb");
  }

  private gradleWrapperPath(gradleRoot: string): string | undefined {
    const wrapper = process.platform === "win32" ? path.join(gradleRoot, "gradlew.bat") : path.join(gradleRoot, "gradlew");
    return fs.existsSync(wrapper) ? wrapper : undefined;
  }
}

async function resolveAndroidCommandLineToolsUrl(): Promise<string> {
  const xml = await downloadText(ANDROID_REPOSITORY_XML);
  const hostOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macosx" : "linux";
  const packageMatch = xml.match(/<remotePackage[^>]+path="cmdline-tools;latest"[\s\S]*?<\/remotePackage>/);
  const packageXml = packageMatch?.[0];
  if (!packageXml) {
    throw new Error("Android repository 中未找到 cmdline-tools;latest。");
  }

  const archivePattern = new RegExp(`<archive>[\\s\\S]*?<host-os>${hostOs}</host-os>[\\s\\S]*?<url>([^<]+)</url>[\\s\\S]*?</archive>`);
  const archive = packageXml.match(archivePattern)?.[1];
  if (!archive) {
    throw new Error(`Android repository 中未找到 ${hostOs} command line tools。`);
  }
  return `https://dl.google.com/android/repository/${archive}`;
}

function downloadText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      if (isRedirect(response.statusCode) && response.headers.location) {
        void downloadText(response.headers.location).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败 ${response.statusCode}: ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
}

function downloadFile(url: string, targetPath: string, output: vscode.OutputChannel): Promise<void> {
  ensureDirectory(path.dirname(targetPath));
  output.appendLine(`下载: ${url}`);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(targetPath);
    https.get(url, response => {
      if (isRedirect(response.statusCode) && response.headers.location) {
        file.close();
        fs.rmSync(targetPath, { force: true });
        void downloadFile(response.headers.location, targetPath, output).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.rmSync(targetPath, { force: true });
        reject(new Error(`下载失败 ${response.statusCode}: ${url}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", error => {
      file.close();
      fs.rmSync(targetPath, { force: true });
      reject(error);
    });
  });
}

function expandZip(archivePath: string, targetRoot: string): Promise<void> {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  ensureDirectory(targetRoot);
  if (process.platform === "win32") {
    return runHidden("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Expand-Archive", "-LiteralPath", archivePath, "-DestinationPath", targetRoot, "-Force"], process.cwd());
  }
  return runHidden("unzip", ["-q", archivePath, "-d", targetRoot], process.cwd());
}

function runToolWithOutput(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, output: vscode.OutputChannel, input?: string): Promise<void> {
  output.appendLine(`> ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const invocation = resolveWindowsBatchInvocation(command, args);
    const child = cp.spawn(invocation.command, invocation.args, { cwd, env, shell: false });
    child.stdout.on("data", data => output.append(data.toString()));
    child.stderr.on("data", data => output.append(data.toString()));
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 退出码 ${code ?? "unknown"}`)));
    if (input) {
      child.stdin.end(input);
    }
  });
}

function resolveWindowsBatchInvocation(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(bat|cmd)$/i.test(command)) {
    return { command, args };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/c", "call", command, ...args]
  };
}

function runHidden(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, shell: false, windowsHide: true });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 退出码 ${code ?? "unknown"}`)));
  });
}

function findExecutable(name: string): string | undefined {
  const executable = process.platform === "win32" && !name.toLocaleLowerCase().endsWith(".exe") ? `${name}.exe` : name;
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!folder) {
      continue;
    }
    const candidate = path.join(folder, executable);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findFiles(rootPath: string, predicate: (file: string) => boolean): string[] {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...findFiles(fullPath, predicate));
      continue;
    }
    if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function replaceDirectory(source: string, target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
  ensureDirectory(path.dirname(target));
  try {
    fs.renameSync(source, target);
  } catch {
    fs.cpSync(source, target, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function isRedirect(statusCode: number | undefined): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
