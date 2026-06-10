export interface TlyClassRef {
  className?: string;
}

export interface TlyPropertyName {
  name?: string;
}

export interface TlyPropertyValue {
  value?: unknown;
}

export interface TlyProperty {
  propName?: TlyPropertyName;
  propValue?: TlyPropertyValue;
  isAt?: boolean;
}

export interface TlyEntity {
  class?: TlyClassRef;
  typeClass?: TlyClassRef;
  nameProp?: TlyProperty;
  properties?: TlyProperty[];
  children?: TlyEntity[];
}

export interface ViewEditableProperty {
  name: string;
  type?: string;
  mangledName?: string;
}

export interface ViewClassInfo {
  name: string;
  mangledName?: string;
  isContainer?: boolean;
  viewProperties: ViewEditableProperty[];
  containerProperties: ViewEditableProperty[];
}

export interface LayoutDesignerState {
  title: string;
  sourcePath: string;
  root: TlyEntity;
  viewClasses: ViewClassInfo[];
  basicProperties: ViewEditableProperty[];
}

export function parseTlyJson(text: string): TlyEntity | undefined {
  if (!text.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(text) as unknown;
  return normalizeEntity(parsed);
}

export function createDefaultRoot(viewClasses: ViewClassInfo[]): TlyEntity | undefined {
  const rootClass = viewClasses.find(item => item.isContainer) ?? viewClasses[0];
  if (!rootClass) {
    return undefined;
  }

  const name = `${simpleClassName(rootClass.name)}1`;
  return {
    class: { className: rootClass.name },
    nameProp: createProperty("名称", name),
    properties: [
      createProperty("宽度", -1),
      createProperty("高度", -1)
    ],
    children: []
  };
}

export function normalizeViewClasses(values: unknown[]): ViewClassInfo[] {
  const result: ViewClassInfo[] = [];
  for (const value of values) {
    const raw = value as Record<string, unknown>;
    const name = String(raw.name ?? "");
    if (!name) {
      continue;
    }
    result.push({
      name,
      mangledName: stringOrUndefined(raw.mangledName),
      isContainer: Boolean(raw.isContainer),
      viewProperties: normalizeEditableProperties(raw.viewProperties),
      containerProperties: normalizeEditableProperties(raw.containerProperties)
    });
  }
  return result;
}

export function normalizeEditableProperties(values: unknown): ViewEditableProperty[] {
  const items = Array.isArray(values) ? values : [];
  const result: ViewEditableProperty[] = [];
  for (const value of items) {
    const raw = value as Record<string, unknown>;
    const name = String(raw.name ?? "");
    if (!name) {
      continue;
    }
    result.push({
      name,
      type: stringOrUndefined(raw.type),
      mangledName: stringOrUndefined(raw.mangledName)
    });
  }
  return result;
}

function normalizeEntity(value: unknown): TlyEntity | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as TlyEntity;
  const className = raw.class?.className ?? raw.typeClass?.className;
  const entity: TlyEntity = {
    class: className ? { className } : raw.class,
    nameProp: normalizeProperty(raw.nameProp),
    properties: Array.isArray(raw.properties)
      ? raw.properties.map(normalizeProperty).filter((item): item is TlyProperty => Boolean(item))
      : [],
    children: Array.isArray(raw.children)
      ? raw.children.map(normalizeEntity).filter((item): item is TlyEntity => Boolean(item))
      : []
  };
  return entity;
}

function normalizeProperty(value: unknown): TlyProperty | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as TlyProperty;
  const name = raw.propName?.name;
  if (!name) {
    return undefined;
  }
  return {
    propName: { name },
    propValue: { value: raw.propValue?.value },
    isAt: raw.isAt
  };
}

function createProperty(name: string, value: unknown, isAt = false): TlyProperty {
  return {
    propName: { name },
    propValue: { value },
    isAt
  };
}

function simpleClassName(value: string): string {
  const index = Math.max(value.lastIndexOf("."), value.lastIndexOf("。"));
  return index >= 0 ? value.slice(index + 1) : value;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
