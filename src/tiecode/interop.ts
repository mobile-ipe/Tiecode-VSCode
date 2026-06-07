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
  const parsed = parseNativeResult(value) as any;
  if (parsed && parsed !== value) {
    return nativeListToArray(parsed);
  }
  if (Array.isArray(parsed)) {
    return parsed as T[];
  }
  if (typeof parsed.size === "function" && typeof parsed.get === "function") {
    const result: T[] = [];
    for (let index = 0; index < parsed.size(); index += 1) {
      result.push(parsed.get(index) as T);
    }
    return result;
  }
  if (Array.isArray(parsed?.items)) {
    return parsed.items as T[];
  }
  if (Array.isArray(parsed?.values)) {
    return parsed.values as T[];
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
  const parsed = parseNativeResult(edits) as any;
  const items = parsed?.edits ?? parsed?.textEdits ?? parsed;
  return nativeListToArray(items).map(toVscodeTextEdit);
}

export function toVscodeUri(value: any): vscode.Uri {
  const uri = tryToVscodeUri(value);
  if (uri) {
    return uri;
  }
  return vscode.Uri.file(path.normalize(String(value ?? "")));
}

export function tryToVscodeUri(value: any): vscode.Uri | undefined {
  const raw = uriToString(value);
  if (!raw) {
    return undefined;
  }
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
  if (typeof value.getLocalPath === "function") {
    return value.getLocalPath();
  }
  for (const key of ["uri", "fsPath", "localPath", "path"]) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  if (typeof value.toString === "function" && value.toString !== Object.prototype.toString) {
    const text = value.toString();
    if (text && text !== "[object Object]") {
      return text;
    }
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
  const uri = tryToVscodeUri(location.uri);
  return uri ? new vscode.Location(uri, toVscodeRange(location.range)) : undefined;
}

export function toWorkspaceEdit(projectEdit: any): vscode.WorkspaceEdit {
  const workspaceEdit = new vscode.WorkspaceEdit();
  const parsed = parseNativeResult(projectEdit) as any;
  addFileEdits(workspaceEdit, parsed?.fileEdits ?? parsed?.changes ?? parsed);
  if (workspaceEdit.size === 0 && projectEdit !== parsed) {
    addFileEdits(workspaceEdit, projectEdit?.fileEdits ?? projectEdit?.changes ?? projectEdit);
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

function addFileEdits(workspaceEdit: vscode.WorkspaceEdit, fileEdits: any): boolean {
  if (!fileEdits) {
    return false;
  }
  const parsed = parseNativeResult(fileEdits) as any;
  if (parsed && parsed !== fileEdits) {
    return addFileEdits(workspaceEdit, parsed);
  }

  if (isNativeMap(parsed)) {
    for (const uri of nativeListToArray(parsed.keys())) {
      setFileEdits(workspaceEdit, uri, parsed.get(uri));
    }
    return true;
  }

  if (Array.isArray(parsed)) {
    let handled = false;
    for (const entry of parsed) {
      handled = addFileEditEntry(workspaceEdit, entry) || handled;
    }
    return handled;
  }

  if (typeof parsed !== "object") {
    return false;
  }

  for (const key of ["entries", "items", "fileEdits", "changes"]) {
    if (parsed[key] && addFileEdits(workspaceEdit, parsed[key])) {
      return true;
    }
  }

  let handled = false;
  for (const [uri, edits] of Object.entries(parsed)) {
    if (uri === "size" || uri === "keys") {
      continue;
    }
    handled = setFileEdits(workspaceEdit, uri, edits) || handled;
  }
  return handled;
}

function addFileEditEntry(workspaceEdit: vscode.WorkspaceEdit, entry: any): boolean {
  if (!entry) {
    return false;
  }
  if (Array.isArray(entry) && entry.length >= 2) {
    return setFileEdits(workspaceEdit, entry[0], entry[1]);
  }

  const uri = entry.uri ?? entry.key ?? entry.file ?? entry.fileUri ?? entry.path;
  const edits = entry.edits ?? entry.value ?? entry.textEdits ?? entry.changes;
  return setFileEdits(workspaceEdit, uri, edits);
}

function setFileEdits(workspaceEdit: vscode.WorkspaceEdit, uriValue: any, editsValue: any): boolean {
  const uri = tryToVscodeUri(uriValue);
  const edits = toVscodeTextEdits(editsValue);
  if (!uri || edits.length === 0) {
    return false;
  }
  workspaceEdit.set(uri, edits);
  return true;
}
