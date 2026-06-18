const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

export interface PostMortemInput {
  teamA: string;
  teamB: string;
  winner: string;
  result: string;
  teamAPercent: number;
  teamBPercent: number;
  reasons: string[];
}

export async function generatePostMortem(input: PostMortemInput): Promise<string> {
  const reasonsText = input.reasons.length > 0
    ? input.reasons.slice(0, 8).join("; ")
    : "No community reasons recorded.";

  const prompt = `Match: ${input.teamA} vs ${input.teamB}. Result: ${input.result}. Community split: ${input.teamAPercent}% predicted ${input.teamA}, ${input.teamBPercent}% predicted ${input.teamB}. Community reasons given: ${reasonsText}. Explain what happened and what the crowd missed or got right.`;

  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text: "You are Chronicle, a football intelligence agent with memory of community predictions for the 2026 World Cup. You analyze why matches unfolded as they did, referencing what the community believed beforehand and where they were right or wrong. Be sharp, specific, and slightly dramatic. Max 150 words."
        }]
      },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 250,
        temperature: 0.8,
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${err}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "Analysis unavailable.";
}
