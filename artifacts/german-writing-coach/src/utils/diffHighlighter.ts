export function getDiffWords(original: string, corrected: string): { type: "added" | "removed" | "unchanged", text: string }[] {
  // A simple word differ for mock purposes. 
  // In a real app, use a robust library like 'diff' or the backend provides explicit spans.
  const origWords = original.split(/\s+/);
  const corrWords = corrected.split(/\s+/);
  
  const result: { type: "added" | "removed" | "unchanged", text: string }[] = [];
  
  let i = 0;
  let j = 0;
  
  while (i < origWords.length || j < corrWords.length) {
    if (i < origWords.length && j < corrWords.length && origWords[i] === corrWords[j]) {
      result.push({ type: "unchanged", text: origWords[i] });
      i++;
      j++;
    } else if (i < origWords.length && !corrWords.includes(origWords[i])) {
      result.push({ type: "removed", text: origWords[i] });
      i++;
    } else if (j < corrWords.length && !origWords.includes(corrWords[j])) {
      result.push({ type: "added", text: corrWords[j] });
      j++;
    } else {
      // rough fallback
      result.push({ type: "removed", text: origWords[i] });
      result.push({ type: "added", text: corrWords[j] });
      i++;
      j++;
    }
  }
  
  return result;
}
