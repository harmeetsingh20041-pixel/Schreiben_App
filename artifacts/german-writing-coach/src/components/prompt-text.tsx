import { cn } from "@/lib/utils";

interface PromptTextProps {
  prompt: string | null | undefined;
  className?: string;
  preview?: boolean;
}

function displayPrompt(prompt: string) {
  return prompt
    .replace(/\\n/g, "\n")
    .replace(/\n(- )/, "\n\n$1");
}

export function PromptText({ prompt, className, preview = false }: PromptTextProps) {
  if (!prompt) return null;

  const text = displayPrompt(prompt);

  return (
    <p className={cn("whitespace-pre-line leading-relaxed", preview && "leading-normal", className)}>
      {text}
    </p>
  );
}
