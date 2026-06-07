import { match, pinyin } from "pinyin-pro";

export interface PinyinCompletionTarget {
  label: string;
  insertText?: string;
  symbolName?: string;
  sortText?: string;
}

interface TextKeys {
  keys: string[];
}

const textKeysCache = new Map<string, TextKeys>();

export function shouldRequestBroadPinyinCompletion(partial: string): boolean {
  return isAsciiPinyinPartial(partial) && partial.length >= 2;
}

function isAsciiPinyinPartial(partial: string): boolean {
  return /^[A-Za-z_@][A-Za-z0-9_@]*$/.test(partial);
}

export function filterAndSortPinyinCompletionItems<T>(
  items: T[],
  partial: string,
  toTarget: (item: T) => PinyinCompletionTarget
): T[] {
  if (!isAsciiPinyinPartial(partial)) {
    return items;
  }

  return items
    .map((item, index) => ({
      item,
      index,
      score: getPinyinCompletionScore(toTarget(item), partial)
    }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== undefined)
    .sort((left, right) => compareScoredItems(left.score, right.score, left.index, right.index))
    .map(entry => entry.item);
}

export function sortPinyinCompletionItems<T>(
  items: T[],
  partial: string,
  toTarget: (item: T) => PinyinCompletionTarget
): T[] {
  if (!isAsciiPinyinPartial(partial)) {
    return items;
  }

  return items
    .map((item, index) => ({
      item,
      index,
      score: getPinyinCompletionScore(toTarget(item), partial) ?? 9000 + index
    }))
    .sort((left, right) => compareScoredItems(left.score, right.score, left.index, right.index))
    .map(entry => entry.item);
}

export function makePinyinCompletionFilterText(target: PinyinCompletionTarget, partial?: string): string | undefined {
  if (!partial || !isAsciiPinyinPartial(partial)) {
    return undefined;
  }
  return [partial, ...completionTextKeys(target)].filter(Boolean).join(" ");
}

export function makePinyinCompletionSortText(
  target: PinyinCompletionTarget,
  partial: string | undefined,
  fallback: string | undefined
): string | undefined {
  if (!partial || !isAsciiPinyinPartial(partial)) {
    return fallback;
  }
  const score = getPinyinCompletionScore(target, partial);
  if (score === undefined) {
    return fallback;
  }
  return `${String(score).padStart(4, "0")}#${fallback ?? target.label}`;
}

function getPinyinCompletionScore(target: PinyinCompletionTarget, partial: string): number | undefined {
  const lowerPartial = partial.toLocaleLowerCase();
  return minDefined(
    scoreText(target.label, lowerPartial, 0),
    scoreText(target.insertText ?? "", lowerPartial, 200),
    scoreText(target.symbolName ?? "", lowerPartial, 500)
  );
}

function scoreText(text: string, partial: string, baseScore: number): number | undefined {
  if (!text) {
    return undefined;
  }

  const keys = textKeys(text).keys;
  const directScore = minDefined(...keys.map(key => scoreKey(key, partial, baseScore)));
  const matchScore = match(text, partial) ? baseScore + 80 : undefined;
  return minDefined(directScore, matchScore);
}

function scoreKey(key: string, partial: string, baseScore: number): number | undefined {
  if (!key) {
    return undefined;
  }
  if (key === partial) {
    return baseScore;
  }
  if (key.startsWith(partial)) {
    return baseScore + 1;
  }
  const index = key.indexOf(partial);
  return index >= 0 ? baseScore + 30 + index : undefined;
}

function completionTextKeys(target: PinyinCompletionTarget): string[] {
  const keys = [
    ...textKeys(target.label).keys,
    ...textKeys(target.insertText ?? "").keys,
    ...textKeys(target.symbolName ?? "").keys
  ];
  return unique(keys);
}

function textKeys(text: string): TextKeys {
  const cached = textKeysCache.get(text);
  if (cached) {
    return cached;
  }

  const parts = splitSymbolText(text);
  const keys = unique([
    normalizeKey(text),
    ...parts.map(normalizeKey),
    ...parts.flatMap(part => pinyinKeys(part)),
    ...pinyinKeys(text)
  ]);
  const result = { keys };
  textKeysCache.set(text, result);
  return result;
}

function pinyinKeys(text: string): string[] {
  if (!text || !/[\u4e00-\u9fff]/u.test(text)) {
    return [];
  }
  try {
    return unique([
      normalizeKey(pinyin(text, { toneType: "none" })),
      normalizeKey(pinyin(text, { toneType: "none", pattern: "first" }))
    ]);
  } catch {
    return [];
  }
}

function splitSymbolText(text: string): string[] {
  return text
    .split(/[\s._#:$()[\]{}<>，。、“”‘’：；（）【】]+/u)
    .map(part => part.trim())
    .filter(Boolean);
}

function normalizeKey(text: string): string {
  return text.toLocaleLowerCase().replace(/[^a-z0-9_@]+/g, "");
}

function compareScoredItems(leftScore: number, rightScore: number, leftIndex: number, rightIndex: number): number {
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }
  return leftIndex - rightIndex;
}

function minDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
