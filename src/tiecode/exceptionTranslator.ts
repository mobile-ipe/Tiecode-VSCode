import type { TiecodeSourceMapping } from "./sourceMapping";

export interface CrashExceptionInfo {
  className: string;
  message: string;
  rawText: string;
  relation: CrashExceptionRelation;
}

export type CrashExceptionRelation = "error" | "cause" | "suppressed";

export interface CrashExceptionSummary {
  label: "错误" | "原因" | "附带";
  typeName: string;
  message: string;
  rawMessage: string;
}

export function getCrashExceptionLabel(exception: CrashExceptionInfo, index: number): CrashExceptionSummary["label"] {
  if (exception.relation === "cause") {
    return "原因";
  }
  if (exception.relation === "suppressed") {
    return "附带";
  }
  return index === 0 ? "错误" : "原因";
}

export function translateCrashException(exception: CrashExceptionInfo, mapping: TiecodeSourceMapping | undefined): Omit<CrashExceptionSummary, "label"> {
  return {
    typeName: translateCrashExceptionName(exception.className, mapping),
    message: translateCrashExceptionMessage(exception.className, exception.message, mapping),
    rawMessage: restoreCrashText(exception.message, mapping)
  };
}

function translateCrashExceptionName(className: string, mapping: TiecodeSourceMapping | undefined): string {
  if (isExceptionType(className, "NullPointerException")) {
    return "空指针异常";
  }
  if (isExceptionType(className, "RuntimeException")) {
    return "运行时异常";
  }
  if (isExceptionType(className, "ClassCastException")) {
    return "强制转换类型异常";
  }
  if (isExceptionType(className, "ArrayIndexOutOfBoundsException")) {
    return "数组索引越界异常";
  }
  if (isExceptionType(className, "IndexOutOfBoundsException")) {
    return "索引越界异常";
  }
  if (isExceptionType(className, "CalledFromWrongThreadException")) {
    return "更新界面组件异常";
  }
  if (isExceptionType(className, "NetworkOnMainThreadException")) {
    return "主线程网络异常";
  }
  if (isExceptionType(className, "ActivityNotFoundException")) {
    return "窗口未找到异常";
  }
  if (isExceptionType(className, "SecurityException")) {
    return "权限异常";
  }
  if (isExceptionType(className, "Resources$NotFoundException")) {
    return "资源未找到异常";
  }
  if (isExceptionType(className, "IllegalArgumentException")) {
    return "参数异常";
  }
  if (isExceptionType(className, "IllegalStateException")) {
    return "状态异常";
  }
  return restoreQualifiedName(className, mapping);
}

function translateCrashExceptionMessage(className: string, message: string, mapping: TiecodeSourceMapping | undefined): string {
  const rawMessage = message.trim();
  if (rawMessage.length === 0) {
    return "";
  }
  if (isExceptionType(className, "RuntimeException")) {
    return translateRuntimeMessage(rawMessage, mapping);
  }
  if (isExceptionType(className, "NullPointerException")) {
    return translateNullPointerMessage(rawMessage, mapping);
  }
  if (isExceptionType(className, "ClassCastException")) {
    return translateClassCastMessage(rawMessage, mapping);
  }
  if (isExceptionType(className, "ArrayIndexOutOfBoundsException") || isExceptionType(className, "IndexOutOfBoundsException")) {
    return translateArrayIndexMessage(rawMessage, mapping);
  }
  if (isExceptionType(className, "CalledFromWrongThreadException")) {
    return translateCalledFromWrongThreadMessage(rawMessage, mapping);
  }
  if (isExceptionType(className, "NetworkOnMainThreadException")) {
    return "不能在主线程执行网络请求";
  }
  if (isExceptionType(className, "ActivityNotFoundException")) {
    return translateActivityNotFoundMessage(rawMessage, mapping);
  }
  if (isExceptionType(className, "SecurityException") && /Permission Denial/i.test(rawMessage)) {
    return `权限不足: ${restoreCrashText(rawMessage, mapping)}`;
  }
  if (isExceptionType(className, "Resources$NotFoundException")) {
    return `找不到资源: ${restoreCrashText(rawMessage, mapping)}`;
  }
  return restoreCrashText(rawMessage, mapping);
}

function translateRuntimeMessage(message: string, mapping: TiecodeSourceMapping | undefined): string {
  if (/Unable to start activity/.test(message)) {
    return translateUnableStartActivityMessage(message, mapping);
  }
  if (/Can't toast/i.test(message)) {
    return "不能在非主线程进行弹出提示等界面操作";
  }
  if (/setOnClickListener for an AdapterView/i.test(message)) {
    return "不能为适配器组件（如列表框、下拉列表框等）设置被单击事件，也许你是想设置项目被单击事件写错了";
  }
  return restoreCrashText(message, mapping);
}

function translateUnableStartActivityMessage(message: string, mapping: TiecodeSourceMapping | undefined): string {
  const component = message.match(/ComponentInfo\{([^}]+)\}/);
  if (!component) {
    return `无法启动窗口: ${restoreCrashText(message, mapping)}`;
  }
  const componentText = restoreActivityComponent(component[1] ?? "", mapping);
  const suffix = message.slice((component.index ?? 0) + component[0].length).trim();
  const restoredSuffix = restoreCrashText(removeEmbeddedExceptionSuffix(suffix), mapping);
  return `无法启动窗口: ${componentText}${restoredSuffix ? (restoredSuffix.startsWith(":") ? restoredSuffix : ` ${restoredSuffix}`) : ""}`;
}

function removeEmbeddedExceptionSuffix(text: string): string {
  return /^:\s*(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error)(?::|\s|$)/.test(text) ? "" : text;
}

function translateNullPointerMessage(message: string, mapping: TiecodeSourceMapping | undefined): string {
  if (/Attempt to get length of null array/i.test(message) || /Cannot read the array length because .* is null/i.test(message)) {
    return "获取数组长度时，所给出的数组对象为空对象";
  }

  if (/Cannot (?:load from|store to) .+ array because .* is null/i.test(message) || /Attempt to (?:read from|write to) null array/i.test(message)) {
    return "访问数组元素时，所给出的数组对象为空对象";
  }

  const invoke = message.match(/Attempt to invoke (?:virtual|interface|direct|static) method ['"]([^'"]+)['"]/i)
    ?? message.match(/Cannot invoke ['"]([^'"]+)['"] because .* is null/i);
  if (invoke) {
    return translateNullMethodMessage(invoke[1] ?? "", mapping);
  }

  const field = message.match(/Attempt to (?:read from|write to) field ['"]([^'"]+)['"]/i);
  if (field) {
    return `访问字段"${restoreJavaMemberName(field[1] ?? "", mapping)}"时该对象为空对象`;
  }

  const javaField = message.match(/Cannot (?:read|assign) field ['"]([^'"]+)['"] because .* is null/i);
  if (javaField) {
    return `访问字段"${restoreJavaMemberName(javaField[1] ?? "", mapping)}"时该对象为空对象`;
  }

  const nullTarget = message.match(/because\s+(.+?)\s+is null/i);
  if (nullTarget) {
    return `使用${restoreCrashText(nullTarget[1] ?? "对象", mapping)}时该对象为空对象`;
  }

  if (/on a null object reference/i.test(message)) {
    return "使用对象时该对象为空对象";
  }

  if (/throw with null exception/i.test(message)) {
    return "抛出了空异常对象";
  }

  return restoreCrashText(message, mapping);
}

function translateNullMethodMessage(signature: string, mapping: TiecodeSourceMapping | undefined): string {
  const member = parseJavaMemberSignature(signature);
  if (!member) {
    return `调用方法"${restoreCrashText(signature, mapping)}"时该对象为空对象`;
  }

  const className = member.className ? restoreQualifiedName(member.className, mapping) : "";
  const methodName = restoreSimpleName(member.memberName, mapping);
  const target = className ? `"${className}"中的` : "";
  if (member.memberName.endsWith("_s") || methodName.endsWith("_s")) {
    return `订阅${target}事件"${methodName}"时该对象为空对象`;
  }
  return `调用${target}方法"${methodName}"所给出的类对象为空对象`;
}

function translateClassCastMessage(message: string, mapping: TiecodeSourceMapping | undefined): string {
  const match = message.match(/(?:class\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+cannot be cast to\s+(?:class\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/i);
  if (!match) {
    return restoreCrashText(message, mapping);
  }
  const fromType = restoreQualifiedName(match[1] ?? "", mapping);
  const toType = restoreQualifiedName(match[2] ?? "", mapping);
  return `"${fromType}"无法转换为"${toType}"`;
}

function translateArrayIndexMessage(message: string, mapping: TiecodeSourceMapping | undefined): string {
  const lengthIndex = message.match(/length\s*=\s*(-?\d+).*index\s*=\s*(-?\d+)/i);
  if (lengthIndex) {
    return `数组长度: ${lengthIndex[1]}, 访问索引: ${lengthIndex[2]}`;
  }

  const indexLength = message.match(/index\s*=\s*(-?\d+).*length\s*=\s*(-?\d+)/i);
  if (indexLength) {
    return `数组长度: ${indexLength[2]}, 访问索引: ${indexLength[1]}`;
  }

  const outOfBounds = message.match(/Index\s+(-?\d+)\s+out of bounds for length\s+(-?\d+)/i);
  if (outOfBounds) {
    return `数组长度: ${outOfBounds[2]}, 访问索引: ${outOfBounds[1]}`;
  }

  const outOfRange = message.match(/Array index out of range:\s*(-?\d+)/i);
  if (outOfRange) {
    return `访问索引越界: ${outOfRange[1]}`;
  }

  return restoreCrashText(message, mapping);
}

function translateCalledFromWrongThreadMessage(message: string, mapping: TiecodeSourceMapping | undefined): string {
  if (/Only the original thread/i.test(message)) {
    return "只有组件的原始线程能够更新组件，安卓系统中组件一般在主线程创建，所以不能在其他线程更新组件";
  }
  return restoreCrashText(message, mapping);
}

function translateActivityNotFoundMessage(message: string, mapping: TiecodeSourceMapping | undefined): string {
  const explicitActivity = message.match(/Unable to find explicit activity class\s*\{([^}]+)\}/i);
  if (explicitActivity) {
    return `找不到要启动的窗口: ${restoreActivityComponent(explicitActivity[1] ?? "", mapping)}`;
  }
  return restoreCrashText(message, mapping);
}

function restoreActivityComponent(component: string, mapping: TiecodeSourceMapping | undefined): string {
  const separator = component.indexOf("/");
  if (separator < 0) {
    return restoreCrashText(component, mapping);
  }

  const packageName = component.slice(0, separator);
  const activityName = component.slice(separator + 1);
  const qualifiedActivity = activityName.startsWith(".") ? `${packageName}${activityName}` : activityName;
  return `${restoreQualifiedName(packageName, mapping)}/${restoreQualifiedName(qualifiedActivity, mapping)}`;
}

function restoreJavaMemberName(signature: string, mapping: TiecodeSourceMapping | undefined): string {
  const member = parseJavaMemberSignature(signature);
  if (!member) {
    return restoreCrashText(signature, mapping);
  }
  const memberName = restoreSimpleName(member.memberName, mapping);
  return member.className ? `${restoreQualifiedName(member.className, mapping)}.${memberName}` : memberName;
}

function parseJavaMemberSignature(signature: string): { className?: string; memberName: string } | undefined {
  const normalized = signature.replace(/\(.*$/, "").trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const qualifiedMember = tokens.at(-1) ?? "";
  const dot = qualifiedMember.lastIndexOf(".");
  if (dot < 0) {
    return qualifiedMember ? { memberName: qualifiedMember } : undefined;
  }
  return {
    className: qualifiedMember.slice(0, dot),
    memberName: qualifiedMember.slice(dot + 1)
  };
}

function restoreCrashText(text: string, mapping: TiecodeSourceMapping | undefined): string {
  return mapping?.restoreText(text) ?? text;
}

function restoreQualifiedName(name: string, mapping: TiecodeSourceMapping | undefined): string {
  return mapping?.restoreQualifiedName(name) ?? name;
}

function restoreSimpleName(name: string, mapping: TiecodeSourceMapping | undefined): string {
  return mapping?.getOriginalName(name) ?? name;
}

function isExceptionType(className: string, typeName: string): boolean {
  return className === typeName || className.endsWith(`.${typeName}`) || className.endsWith(`$${typeName}`);
}
