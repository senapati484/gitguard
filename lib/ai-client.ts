/**
 * lib/ai-client.ts
 *
 * Unified AI Client for GitGuard Agents.
 *
 * Provider Strategy:
 *   1. Primary: Groq API (ultra-fast inference via llama-3.3-70b-versatile or llama-3.1-8b-instant).
 *   2. Fallback: Google Gemini API (gemini-1.5-flash or gemini-2.0-flash).
 *
 * Zero third-party SDK dependencies (uses native fetch).
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  messages: ChatMessage[];
  temperature?: number;
  jsonMode?: boolean;
}

/**
 * Generate a chat completion using Groq with Gemini fallback.
 */
export async function generateAICompletion(
  options: CompletionOptions
): Promise<string> {
  const { messages, temperature = 0.1, jsonMode = true } = options;

  // ── 1. Primary: Groq API ──────────────────────────────────────────────────
  const groqApiKey = process.env.GROQ_API_KEY;
  if (groqApiKey) {
    const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
    try {
      console.log(`[ai-client] Calling Groq API (model: ${groqModel})...`);
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: groqModel,
          messages,
          temperature,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          console.log(`[ai-client] Groq response received successfully`);
          return content;
        }
      } else {
        const errorText = await res.text();
        console.warn(
          `[ai-client] Groq API returned status ${res.status}: ${errorText}. Falling back to Gemini...`
        );
      }
    } catch (err) {
      console.warn(
        `[ai-client] Groq API request failed:`,
        err instanceof Error ? err.message : err,
        `Falling back to Gemini...`
      );
    }
  } else {
    console.log(`[ai-client] GROQ_API_KEY not set. Checking Gemini fallback...`);
  }

  // ── 2. Fallback: Google Gemini API ────────────────────────────────────────
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (geminiApiKey) {
    const geminiModel = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    try {
      console.log(`[ai-client] Calling Google Gemini API (model: ${geminiModel})...`);

      // Separate system prompt from user/assistant messages for Gemini format
      const systemMessages = messages.filter((m) => m.role === "system");
      const conversationMessages = messages.filter((m) => m.role !== "system");

      const systemInstruction = systemMessages.length > 0
        ? {
            parts: systemMessages.map((m) => ({ text: m.content })),
          }
        : undefined;

      const contents = conversationMessages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(systemInstruction ? { systemInstruction } : {}),
          contents,
          generationConfig: {
            temperature,
            ...(jsonMode ? { responseMimeType: "application/json" } : {}),
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          console.log(`[ai-client] Gemini fallback response received successfully`);
          return text;
        }
      } else {
        const errorText = await res.text();
        console.error(`[ai-client] Gemini API error (${res.status}): ${errorText}`);
      }
    } catch (err) {
      console.error(
        `[ai-client] Gemini API request failed:`,
        err instanceof Error ? err.message : err
      );
    }
  } else {
    console.warn(
      `[ai-client] Neither GROQ_API_KEY nor GEMINI_API_KEY is configured.`
    );
  }

  return "";
}
