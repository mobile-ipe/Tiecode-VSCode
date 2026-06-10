import * as vscode from "vscode";
import type { ToolOutputLineHandler } from "./build";
import {
  CrashExceptionInfo,
  CrashExceptionRelation,
  CrashExceptionSummary,
  getCrashExceptionLabel,
  translateCrashException
} from "./exceptionTranslator";
import type { SourceMappedLocation, TiecodeSourceMapping } from "./sourceMapping";

export class LogcatCrashHandler implements ToolOutputLineHandler {
  private activeCrash = false;
  private crashLineBudget = 0;
  private readonly exceptions: CrashExceptionInfo[] = [];
  private readonly crashPayloads: string[] = [];
  private readonly emitted = new Set<string>();
  private readonly rawFrames = new Set<string>();
  private readonly mappedFrames: MappedCrashFrame[] = [];
  private finishTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly mapping: TiecodeSourceMapping | undefined,
    private readonly collection: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel
  ) {}

  handleLine(line: string): boolean {
    if (line.includes("FATAL EXCEPTION")) {
      this.finalizeCrash();
      this.startCrash();
      return true;
    }

    if (!this.activeCrash) {
      return false;
    }

    this.crashLineBudget -= 1;
    if (this.crashLineBudget <= 0) {
      this.finalizeCrash();
      return false;
    }
    this.scheduleFinalize();

    const payload = readLogcatPayload(line);
    this.captureCrashPayload(payload);

    const exception = parseCrashExceptionPayload(payload);
    if (exception) {
      this.captureException(exception);
      return true;
    }

    const frame = parseStackFrame(line);
    if (frame) {
      this.captureFrame(frame);
      return true;
    }

    const rawFrame = parseRawStackFrame(payload);
    if (rawFrame) {
      this.rawFrames.add(rawFrame);
      return true;
    }

    const continuation = parseCrashMessageContinuation(payload);
    if (continuation) {
      this.captureMessageContinuation(continuation);
    }
    return true;
  }

  flush(): void {
    this.finalizeCrash();
  }

  private startCrash(): void {
    this.activeCrash = true;
    this.crashLineBudget = 120;
    this.exceptions.length = 0;
    this.crashPayloads.length = 0;
    this.emitted.clear();
    this.rawFrames.clear();
    this.mappedFrames.length = 0;
    this.scheduleFinalize();
  }

  private captureCrashPayload(payload: string): void {
    if (payload.length === 0) {
      return;
    }
    this.crashPayloads.push(payload);
  }

  private captureException(exception: CrashExceptionInfo): void {
    this.pushException(exception);
    for (const nested of extractEmbeddedCrashExceptions(exception.message)) {
      this.pushException(nested);
    }
  }

  private pushException(exception: CrashExceptionInfo): void {
    if (this.exceptions.some(existing => existing.rawText === exception.rawText && existing.relation === exception.relation)) {
      return;
    }
    this.exceptions.push(exception);
  }

  private captureMessageContinuation(text: string): void {
    const last = this.exceptions.at(-1);
    if (!last) {
      return;
    }
    last.message = `${last.message}${last.message ? " " : ""}${text}`;
    last.rawText = `${last.rawText} ${text}`;
  }

  private captureFrame(frame: StackFrameLine): void {
    const mapped = this.mapping?.mapOutputLine(frame.fileName, frame.line);
    if (!mapped) {
      this.rawFrames.add(frame.rawText);
      return;
    }

    const restoredClass = this.mapping?.restoreQualifiedName(frame.className) ?? frame.className;
    const restoredMethod = this.mapping?.getOriginalName(frame.methodName) ?? frame.methodName;
    const key = `${mapped.sourcePath}:${mapped.sourceLine}:${restoredClass}.${restoredMethod}`;
    if (this.emitted.has(key)) {
      return;
    }
    this.emitted.add(key);
    this.mappedFrames.push({
      mapped,
      frameText: `${restoredClass}.${restoredMethod}`
    });
  }

  private finalizeCrash(): void {
    if (!this.activeCrash) {
      return;
    }
    this.activeCrash = false;
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = undefined;
    }

    this.recoverExceptionsFromPayloads();
    const summaries = this.getCrashSummaries();
    for (const summary of summaries) {
      this.output.appendLine(`=> ${summary.label}类型: ${summary.typeName}`);
      if (summary.message.length > 0) {
        this.output.appendLine(`=> ${summary.label}信息: ${summary.message}`);
      }
      if (summary.rawMessage.length > 0 && summary.rawMessage !== summary.message) {
        this.output.appendLine(`=> 原始${summary.label}信息: ${summary.rawMessage}`);
      }
    }

    const diagnosticSummary = this.getDiagnosticSummary(summaries);
    if (this.mappedFrames.length > 0) {
      for (const frame of this.mappedFrames) {
        this.output.appendLine(`=> 结绳栈帧: ${frame.mapped.sourcePath}:${frame.mapped.sourceLine} ${frame.frameText}`);
        this.addCrashDiagnostic(frame.mapped, `${diagnosticSummary}: ${frame.frameText}`);
      }
      return;
    }

    for (const rawFrame of this.rawFrames) {
      this.output.appendLine(`=> 原始栈帧: ${rawFrame}`);
    }
  }

  private recoverExceptionsFromPayloads(): void {
    for (const payload of this.crashPayloads) {
      const exception = parseCrashExceptionPayload(payload) ?? parseCrashExceptionPayload(payload, true);
      if (exception) {
        this.captureException(exception);
        continue;
      }

      for (const nested of extractEmbeddedCrashExceptions(payload)) {
        this.pushException(nested);
      }
    }
  }

  private getCrashSummaries(): CrashExceptionSummary[] {
    if (this.exceptions.length === 0) {
      return [{
        label: "错误",
        typeName: "Android 崩溃",
        message: "",
        rawMessage: ""
      }];
    }
    return this.exceptions.map((exception, index) => ({
      ...translateCrashException(exception, this.mapping),
      label: getCrashExceptionLabel(exception, index)
    }));
  }

  private getDiagnosticSummary(summaries: CrashExceptionSummary[]): string {
    let cause: CrashExceptionSummary | undefined;
    for (let index = summaries.length - 1; index >= 0; index -= 1) {
      if (summaries[index]?.label === "原因") {
        cause = summaries[index];
        break;
      }
    }
    cause ??= summaries.at(-1);
    if (!cause) {
      return "Android 崩溃";
    }
    return cause.message.length > 0 ? `${cause.typeName}: ${cause.message}` : cause.typeName;
  }

  private scheduleFinalize(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
    }
    this.finishTimer = setTimeout(() => this.finalizeCrash(), 500);
  }

  private addCrashDiagnostic(mapped: SourceMappedLocation, message: string): void {
    const uri = vscode.Uri.file(mapped.sourcePath);
    const existing = this.collection.get(uri) ?? [];
    const line = Math.max(0, mapped.sourceLine - 1);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
      message,
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = "tiecode logcat";
    this.collection.set(uri, [...existing, diagnostic]);
  }
}

interface MappedCrashFrame {
  mapped: SourceMappedLocation;
  frameText: string;
}

interface StackFrameLine {
  className: string;
  methodName: string;
  fileName: string;
  line: number;
  rawText: string;
}

function parseCrashExceptionPayload(payload: string, loose = false): CrashExceptionInfo | undefined {
  const match = loose
    ? payload.match(/(?:(Caused by|Suppressed):\s*)?((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error))(?:\s*:\s*(.*)|\s*$)/)
    : payload.match(/^(?:(Caused by|Suppressed):\s*)?((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error))(?::\s*(.*))?$/);
  if (!match) {
    return undefined;
  }
  const className = match[2] ?? "";
  const message = (match[3] ?? "").trim();
  if (!className || (loose && isCrashMetadataPayload(className))) {
    return undefined;
  }
  return {
    className,
    message,
    rawText: loose ? `${className}${message ? `: ${message}` : ""}` : payload,
    relation: toCrashExceptionRelation(match[1])
  };
}

function extractEmbeddedCrashExceptions(message: string): CrashExceptionInfo[] {
  const tokens = Array.from(message.matchAll(/(?:^|:\s+|Caused by:\s+|Suppressed:\s+)((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error))(?::\s*)/g));
  const exceptions: CrashExceptionInfo[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const className = token?.[1] ?? "";
    const tokenText = token?.[0] ?? "";
    const tokenIndex = token?.index ?? 0;
    const messageStart = tokenIndex + tokenText.length;
    const nextTokenIndex = tokens[index + 1]?.index ?? message.length;
    const nestedMessage = message.slice(messageStart, nextTokenIndex).trim();
    if (!className) {
      continue;
    }
    exceptions.push({
      className,
      message: nestedMessage,
      rawText: `${className}${nestedMessage ? `: ${nestedMessage}` : ""}`,
      relation: /^Suppressed:/i.test(tokenText.trim()) ? "suppressed" : "cause"
    });
  }
  return exceptions;
}

function parseCrashMessageContinuation(payload: string): string | undefined {
  if (
    payload.length === 0
    || isCrashMetadataPayload(payload)
    || parseCrashExceptionPayload(payload)
    || parseRawStackFrame(payload)
  ) {
    return undefined;
  }
  return payload;
}

function parseRawStackFrame(payload: string): string | undefined {
  if (/^(?:at\s+|\.\.\. \d+ more)/.test(payload)) {
    return payload;
  }
  return undefined;
}

function readLogcatPayload(line: string): string {
  return line.match(/\bAndroidRuntime\s*:\s*(.*)$/)?.[1]?.trim() ?? line.trim();
}

function isCrashMetadataPayload(payload: string): boolean {
  return /^(?:FATAL EXCEPTION|Process:|--------- beginning of)/.test(payload);
}

function toCrashExceptionRelation(value: string | undefined): CrashExceptionRelation {
  if (value === "Caused by") {
    return "cause";
  }
  if (value === "Suppressed") {
    return "suppressed";
  }
  return "error";
}

function parseStackFrame(line: string): StackFrameLine | undefined {
  const match = line.match(/\bat\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$<>$]*)\(([^:()]+\.java):(\d+)\)/);
  if (!match) {
    return undefined;
  }

  const frameLine = Number(match[4]);
  if (!Number.isFinite(frameLine)) {
    return undefined;
  }
  return {
    className: match[1] ?? "",
    methodName: match[2] ?? "",
    fileName: match[3] ?? "",
    line: frameLine,
    rawText: line.match(/\bat\s+.*$/)?.[0]?.trim() ?? line.trim()
  };
}
