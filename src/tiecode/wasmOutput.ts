import * as vscode from "vscode";

export interface WasmOutputOptions {
  print: (message: string) => void;
  printErr: (message: string) => void;
}

export function createWasmOutputOptions(output: vscode.OutputChannel): WasmOutputOptions {
  if (!vscode.workspace.getConfiguration("tiecode").get<boolean>("languageService.traceCompilerOutput", false)) {
    return {
      print: () => undefined,
      printErr: () => undefined
    };
  }

  return {
    print: message => output.appendLine(String(message ?? "")),
    printErr: message => output.appendLine(String(message ?? ""))
  };
}
