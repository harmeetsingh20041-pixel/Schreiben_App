import { AIResponse } from "../types";
import { MOCK_AI_RESPONSE } from "../data/mockData";

// TODO: Replace with real DeepSeek integration
export async function checkWriting(text: string): Promise<AIResponse> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(MOCK_AI_RESPONSE);
    }, 3000); // Simulate checking delay
  });
}
