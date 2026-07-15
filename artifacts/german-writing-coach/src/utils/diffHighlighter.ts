import { diffArrays } from "diff";
import {
  sequenceDiffExceedsBudget,
  sharedSequenceBounds,
} from "@/utils/boundedDiff";

export type DiffWord = {
  type: "added" | "removed" | "unchanged";
  text: string;
};

function tokenize(value: string) {
  return value.match(/\s+|[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function linearDiff(original: string, corrected: string): DiffWord[] {
  const originalCharacters = Array.from(original);
  const correctedCharacters = Array.from(corrected);
  const { prefixLength, leftEnd, rightEnd } = sharedSequenceBounds(
    originalCharacters,
    correctedCharacters,
  );
  const chunks: DiffWord[] = [];
  const prefix = originalCharacters.slice(0, prefixLength).join("");
  const removed = originalCharacters.slice(prefixLength, leftEnd).join("");
  const added = correctedCharacters.slice(prefixLength, rightEnd).join("");
  const suffix = originalCharacters.slice(leftEnd).join("");
  if (prefix) chunks.push({ type: "unchanged", text: prefix });
  if (removed) chunks.push({ type: "removed", text: removed });
  if (added) chunks.push({ type: "added", text: added });
  if (suffix) chunks.push({ type: "unchanged", text: suffix });
  return chunks;
}

export function getDiffWords(original: string, corrected: string): DiffWord[] {
  const originalTokens = tokenize(original);
  const correctedTokens = tokenize(corrected);
  if (sequenceDiffExceedsBudget(originalTokens.length, correctedTokens.length)) {
    return linearDiff(original, corrected);
  }

  return diffArrays(originalTokens, correctedTokens).flatMap((change) => {
    const type: DiffWord["type"] = change.added
      ? "added"
      : change.removed
      ? "removed"
      : "unchanged";
    const text = change.value.join("");
    return text ? [{ type, text }] : [];
  });
}
