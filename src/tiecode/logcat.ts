import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { SourceMappingService } from "./sourceMapping";
import { ProjectInfo } from "./types";

export class AndroidLogcatService implements vscode.Disposable {
  private active?: cp.ChildProcessWithoutNullStreams;
  private stopping = false;

  async start(
    project: ProjectInfo,
    adbPath: string,
    env: NodeJS.ProcessEnv,
    output: vscode.OutputChannel,
    sourceMapping: SourceMappingService
  ): Promise<void> {
    this.stop();
    const lineHandler = await sourceMapping.createLogcatDiagnostics(project);
    output.appendLine("正在监听 Android 崩溃日志。");

    const child = cp.spawn(adbPath, ["logcat", "-v", "time", "AndroidRuntime:E", "*:S"], {
      cwd: project.rootPath,
      env,
      shell: false,
      windowsHide: true
    });
    this.active = child;
    this.stopping = false;

    const stdout = new LogcatLineEmitter(line => {
      output.appendLine(line);
      lineHandler?.handleLine(line);
    });
    const stderr = new LogcatLineEmitter(line => output.appendLine(line));

    child.stdout.on("data", data => stdout.write(data.toString("utf8")));
    child.stderr.on("data", data => stderr.write(data.toString("utf8")));
    child.on("error", error => output.appendLine(`logcat 启动失败: ${String(error)}`));
    child.on("close", code => {
      stdout.end();
      stderr.end();
      if (this.active === child) {
        this.active = undefined;
      }
      if (!this.stopping && code !== 0 && code !== null) {
        output.appendLine(`${path.basename(adbPath)} logcat 退出码 ${code}`);
      }
    });
  }

  stop(): void {
    if (!this.active) {
      return;
    }
    this.stopping = true;
    this.active.kill();
    this.active = undefined;
  }

  dispose(): void {
    this.stop();
  }
}

class LogcatLineEmitter {
  private pending = "";

  constructor(private readonly emit: (line: string) => void) {}

  write(text: string): void {
    this.pending += text;
    let newline = this.pending.search(/\r?\n/);
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + (this.pending[newline] === "\r" && this.pending[newline + 1] === "\n" ? 2 : 1));
      this.emit(line);
      newline = this.pending.search(/\r?\n/);
    }
  }

  end(): void {
    if (this.pending.length > 0) {
      this.emit(this.pending.replace(/\r$/, ""));
      this.pending = "";
    }
  }
}
