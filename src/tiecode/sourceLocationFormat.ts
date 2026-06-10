import * as path from "path";
import type { WasmPathMount } from "./wasmPaths";
import { resolveWasmOrHostPath } from "./wasmPaths";

export interface SourceLocation {
  sourcePath: string;
  line?: number;
  column?: number;
}

export function formatSourcePosition(location: SourceLocation): string {
  let result = path.normalize(location.sourcePath);
  if (isPositiveNumber(location.line)) {
    result += `:${Math.trunc(location.line)}`;
  }
  if (isPositiveNumber(location.column)) {
    result += `:${Math.trunc(location.column)}`;
  }
  return result;
}

export function formatLabeledSourceLocation(label: string, location: SourceLocation, detail = ""): string {
  const position = formatSourcePosition(location);
  return detail.length > 0 ? `=> ${label}: ${position}: ${detail}` : `=> ${label}: ${position}`;
}

export function formatTiecodeCompilerOutputLine(line: string, fallbackRoot: string, mounts: WasmPathMount[]): string {
  const diagnostic = parseTiecodeCompilerDiagnosticLine(line);
  if (!diagnostic) {
    return line;
  }

  const sourcePath = resolveWasmOrHostPath(diagnostic.sourcePath, fallbackRoot, mounts);
  const message = diagnostic.message.length > 0 ? `${diagnostic.kind}: ${diagnostic.message}` : diagnostic.kind;
  return `${diagnostic.level} ${formatSourcePosition({
    sourcePath,
    line: diagnostic.line,
    column: diagnostic.column
  })}: ${message}`;
}

interface TiecodeCompilerDiagnosticLine {
  level: string;
  sourcePath: string;
  kind: string;
  line: number;
  column: number;
  message: string;
}

function parseTiecodeCompilerDiagnosticLine(line: string): TiecodeCompilerDiagnosticLine | undefined {
  const match = line.match(/^(\[(?:ERROR|WARNING)\])\s+(.+\.(?:t|tly))[:：]([^:：()]+)\((\d+)(?:,(\d+))?\)[:：]?\s*(.*)$/iu);
  if (!match) {
    return undefined;
  }

  const sourcePath = match[2] ?? "";
  const sourceLine = Number(match[4]);
  const sourceColumn = Number(match[5] ?? 1);
  if (!sourcePath || !Number.isFinite(sourceLine) || sourceLine <= 0) {
    return undefined;
  }

  return {
    level: match[1] ?? "",
    sourcePath,
    kind: (match[3] ?? "").trim(),
    line: sourceLine,
    column: Number.isFinite(sourceColumn) && sourceColumn > 0 ? sourceColumn : 1,
    message: (match[6] ?? "").trim()
  };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
