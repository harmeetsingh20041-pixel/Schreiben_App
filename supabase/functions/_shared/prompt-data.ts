const PROMPT_JSON_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/** Serialize model-visible user content as one inert JSON value. */
export function stringifyUntrustedPromptData(value: unknown) {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => PROMPT_JSON_ESCAPES[character] ?? "",
  );
}
