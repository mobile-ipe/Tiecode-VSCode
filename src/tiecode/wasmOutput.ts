import * as vscode from "vscode";

export interface WasmOutputOptions {
  print: (message: string) => void;
  printErr: (message: string) => void;
}

export function createWasmOutputOptions(output: vscode.OutputChannel): WasmOutputOptions {
  if (!shouldTraceWasmOutput()) {
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

export function shouldTraceWasmOutput(): boolean {
  return vscode.workspace.getConfiguration("tiecode").get<boolean>("wasm.traceOutput", false);
}
