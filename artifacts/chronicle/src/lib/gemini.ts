import { GoogleGenAI } from "@google/genai";

export interface PostMortemInput {
  teamA: string;
  teamB: string;
  winner: string;
  result: string;
  teamAPercent: number;
  teamBPercent: number;
  reasons: string[];
}

function getApiKey(): string {
  const primary = import.meta.env.VITE_GEMINI_API_KEY as string;
  const backup = import.meta.env.VITE_GEMINI_API_KEY_2 as string;
  return primary || backup || "";
}

export async function generatePostMortem(input: PostMortemInput): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No Gemini API key configured");

  const reasonsText =
    input.reasons.length > 0
      ? input.reasons.slice(0, 8).join("; ")
      : "No community reasons recorded.";

  const prompt = `Match: ${input.teamA} vs ${input.teamB}. Result: ${input.result}. Community split: ${input.teamAPercent}% predicted ${input.teamA}, ${input.teamBPercent}% predicted ${input.teamB}. Community reasons: ${reasonsText}. Explain what happened and what the crowd missed or got right.`;

  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      systemInstruction:
        "You are Chronicle, a football intelligence agent with memory of community predictions for the 2026 World Cup. You analyze why matches unfolded as they did, referencing what the community believed beforehand and where they were right or wrong. Be sharp, specific, and slightly dramatic. Write 3-4 full sentences, approximately 100-150 words.",
      maxOutputTokens: 600,
      temperature: 0.85,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Empty response from Gemini");
  return text.trim();
}
