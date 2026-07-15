export const V1_WRITING_MAX_CHARACTERS = 4_000;
export const V1_WRITING_MAX_FEEDBACK_UNITS = 40;

export const V1_WRITING_CHARACTER_LIMIT_MESSAGE =
  "Writing can be up to 4,000 characters. Shorten it before saving or submitting.";

export function writingUnicodeCharacterCount(value: string) {
  return Array.from(value).length;
}

export function constrainWritingInput(currentValue: string, nextValue: string) {
  const nextCharacters = Array.from(nextValue);
  const currentCharacterCount = writingUnicodeCharacterCount(currentValue);
  if (currentCharacterCount > V1_WRITING_MAX_CHARACTERS) {
    if (nextCharacters.length <= currentCharacterCount) {
      return { value: nextValue, wasLimited: false };
    }
    return { value: currentValue, wasLimited: true };
  }

  if (nextCharacters.length <= V1_WRITING_MAX_CHARACTERS) {
    return { value: nextValue, wasLimited: false };
  }

  return {
    // Reject the whole over-limit edit. Truncating a paste would silently
    // change student work and could then autosave or submit the damaged text.
    value: currentValue,
    wasLimited: true,
  };
}
