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

// ─── Key management ───────────────────────────────────────────────────────────

const PRIMARY_KEY = import.meta.env.VITE_GEMINI_API_KEY as string;
const BACKUP_KEY = import.meta.env.VITE_GEMINI_API_KEY_2 as string;

function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("resource_exhausted") ||
    msg.includes("too many requests")
  );
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (isRateLimitError(err)) return "Analysis paused — API limit reached. Try again in a minute.";
  if (msg.toLowerCase().includes("api key")) return "Analysis unavailable — invalid API key.";
  if (msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch"))
    return "Analysis unavailable — check your connection.";
  if (msg.toLowerCase().includes("empty")) return "Analysis returned empty — please retry.";
  return "Analysis temporarily unavailable. Please try again.";
}

// ─── Core Gemini call ─────────────────────────────────────────────────────────

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  if (!apiKey) throw new Error("No API key provided");

  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      systemInstruction: `You are Chronicle, the definitive intelligence agent for the 2026 World Cup. You write rich, detailed post-match analyses that blend tactical insight, crowd psychology, and football history.

Your analyses must:
1. Open with a dramatic one-sentence verdict on the match
2. Explain the tactical story of the game — formations, pressing, key duels, momentum shifts
3. Assess whether key players delivered or disappointed vs expectations
4. Break down the crowd prediction: why the majority believed what they did, where they were proven right or embarrassingly wrong, and which specific reasons from the community turned out to be prophetic vs naive
5. Identify the single turning point that decided the outcome
6. Close with a punchy line about what this result signals for the rest of the tournament

Write 6-8 full sentences. Aim for 200-280 words. Be analytical, opinionated, and slightly theatrical — like a top football journalist writing for a global audience.`,
      maxOutputTokens: 2000,
      temperature: 0.9,
    },
  });

  const text = response.text;
  if (!text || text.trim().length < 20) throw new Error("Empty response from Gemini");
  return text.trim();
}

// ─── Public API — with backup key fallback ────────────────────────────────────

export async function generatePostMortem(input: PostMortemInput): Promise<string> {
  const reasonsText =
    input.reasons.length > 0
      ? input.reasons.slice(0, 10).join("; ")
      : "No community reasons recorded.";

  const prompt = `World Cup 2026 match: ${input.teamA} vs ${input.teamB}.
Final result: ${input.result}.
Community prediction split: ${input.teamAPercent}% backed ${input.teamA}, ${input.teamBPercent}% backed ${input.teamB}.
Top community reasons given before the match: ${reasonsText}.

Write your Chronicle analysis now.`;

  // Try primary key
  if (PRIMARY_KEY) {
    try {
      return await callGemini(PRIMARY_KEY, prompt);
    } catch (err) {
      if (isRateLimitError(err) && BACKUP_KEY) {
        console.warn("[Chronicle] Primary key rate-limited — switching to backup key");
        // Fall through to backup key
      } else if (BACKUP_KEY) {
        console.warn("[Chronicle] Primary key failed — trying backup:", err instanceof Error ? err.message : err);
        // Fall through to backup key
      } else {
        throw new Error(friendlyError(err));
      }
    }
  }

  // Try backup key
  if (BACKUP_KEY) {
    try {
      return await callGemini(BACKUP_KEY, prompt);
    } catch (err) {
      throw new Error(friendlyError(err));
    }
  }

  throw new Error("No Gemini API key configured. Add GEMINI_API_KEY to your secrets.");
}

// ─── Also export friendlyError for use in other modules ──────────────────────
export { friendlyError };
