import * as path from "path";
import * as vscode from "vscode";

export function parseNativeResult<T = any>(value: any): T | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value.toJson === "function") {
    try {
      return JSON.parse(value.toJson()) as T;
    } catch {
      return value as T;
    }
  }
  return value as T;
}

export function nativeListToArray<T = any>(value: any): T[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (typeof value.size === "function" && typeof value.get === "function") {
    const result: T[] = [];
    for (let index = 0; index < value.size(); index += 1) {
      result.push(value.get(index) as T);
    }
    return result;
  }
  return [];
}

export function toVscodeRange(range: any): vscode.Range {
  const start = range?.start ?? {};
  const end = range?.end ?? start;
  return new vscode.Range(
    Math.max(0, Number(start.line ?? 0)),
    Math.max(0, Number(start.column ?? start.character ?? 0)),
    Math.max(0, Number(end.line ?? start.line ?? 0)),
    Math.max(0, Number(end.column ?? end.character ?? start.column ?? 0))
  );
}

export function toTiecodeRange(tiec: any, range: vscode.Range): any {
  const nativeRange = new tiec.Range();
  nativeRange.start = toTiecodePosition(tiec, range.start);
  nativeRange.end = toTiecodePosition(tiec, range.end);
  return nativeRange;
}

export function toTiecodePosition(tiec: any, position: vscode.Position): any {
  const nativePosition = new tiec.Position();
  nativePosition.line = position.line;
  nativePosition.column = position.character;
  return nativePosition;
}

export function toVscodeTextEdit(edit: any): vscode.TextEdit {
  return new vscode.TextEdit(toVscodeRange(edit?.range), String(edit?.newText ?? ""));
}

export function toVscodeTextEdits(edits: any): vscode.TextEdit[] {
  return nativeListToArray(edits).map(toVscodeTextEdit);
}

export function toVscodeUri(value: any): vscode.Uri {
  const raw = uriToString(value);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return vscode.Uri.parse(raw);
  }
  return vscode.Uri.file(path.normalize(raw));
}

export function uriToString(value: any): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value.toString === "function" && value.toString !== Object.prototype.toString) {
    const text = value.toString();
    if (text && text !== "[object Object]") {
      return text;
    }
  }
  if (typeof value.getLocalPath === "function") {
    return value.getLocalPath();
  }
  if (typeof value.path === "string") {
    return value.path;
  }
  return "";
}

export function toVscodeLocation(location: any): vscode.Location | undefined {
  if (!location?.uri || !location?.range) {
    return undefined;
  }
  return new vscode.Location(toVscodeUri(location.uri), toVscodeRange(location.range));
}

export function toWorkspaceEdit(projectEdit: any): vscode.WorkspaceEdit {
  const workspaceEdit = new vscode.WorkspaceEdit();
  const parsed = parseNativeResult(projectEdit) as any;
  const fileEdits = parsed?.fileEdits;

  if (fileEdits && !isNativeMap(fileEdits) && typeof fileEdits === "object") {
    for (const [uri, edits] of Object.entries(fileEdits)) {
      workspaceEdit.set(toVscodeUri(uri), toVscodeTextEdits(edits));
    }
    return workspaceEdit;
  }

  if (isNativeMap(fileEdits)) {
    for (const uri of nativeListToArray(fileEdits.keys())) {
      workspaceEdit.set(toVscodeUri(uri), toVscodeTextEdits(fileEdits.get(uri)));
    }
  }

  return workspaceEdit;
}

export function textEditsToWorkspaceEdit(uri: vscode.Uri, edits: vscode.TextEdit[]): vscode.WorkspaceEdit {
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(uri, edits);
  return workspaceEdit;
}

function isNativeMap(value: any): boolean {
  return Boolean(value && typeof value.keys === "function" && typeof value.get === "function");
}
