/**
 * lib/ai-client.ts
 *
 * Unified AI Client for GitGuard Agents.
 *
 * Provider Strategy:
 *   1. Primary: Groq API (ultra-fast inference via llama-3.3-70b-versatile or llama-3.1-8b-instant).
 * Zero third-party SDK dependencies (uses native fetch).
 */

import dns from "node:dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // safe fallback in environments where dns is not configurable
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  messages: ChatMessage[];
  temperature?: number;
  jsonMode?: boolean;
  preferredModel?: "sonnet" | "haiku" | "default";
  preferredProvider?: "groq" | "gemini" | "auto";
}


// In-memory circuit breaker for Google Gemini free tier daily quota (20 requests/day limit)
let geminiExhaustedUntil = 0;

export function isGeminiAvailable(): boolean {
  if (!process.env.GEMINI_API_KEY) return false;
  return Date.now() > geminiExhaustedUntil;
}

export function parseRetryDelayMs(errorText: string, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const sec = parseFloat(retryAfterHeader);
    if (!isNaN(sec) && sec > 0) return Math.min(Math.ceil(sec * 1000) + 200, 8000);
  }
  const match = errorText.match(/Please try again in ([0-9.]+)(s|ms)/i);
  if (match) {
    const num = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    const ms = unit === "ms" ? Math.ceil(num) + 150 : Math.ceil(num * 1000) + 300;
    return Math.min(Math.max(ms, 600), 8000);
  }
  return 2500;
}

/**
 * Generate a chat completion using Sonnet (if specified & key present), Groq (primary for fast diffs),
 * or Gemini (for large contexts >50KB or fallback).
 */
export async function generateAICompletion(
  options: CompletionOptions
): Promise<string> {
  const {
    messages,
    temperature = 0.1,
    jsonMode = true,
    preferredModel,
    preferredProvider = "auto",
  } = options;

  // ── 0. Optional Anthropic Sonnet (for Orchestrator synthesis) ──────────────
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (preferredModel === "sonnet" && anthropicApiKey) {
    try {
      console.log(`[ai-client] Calling Anthropic Claude 3.5 Sonnet for Orchestrator...`);
      const systemMessages = messages.filter((m) => m.role === "system");
      const conversationMessages = messages.filter((m) => m.role !== "system");

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 2048,
          system: systemMessages.map((m) => m.content).join("\n\n"),
          messages: conversationMessages.map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const content = data.content?.[0]?.text;
        if (content) {
          console.log(`[ai-client] Sonnet response received successfully`);
          return content;
        }
      } else {
        console.warn(`[ai-client] Anthropic Sonnet returned status ${res.status}. Falling back to Groq/Gemini...`);
      }
    } catch (err) {
      console.warn(`[ai-client] Anthropic Sonnet call failed, falling back:`, err);
    }
  }

  // Calculate total prompt characters to guide routing
  const totalPromptChars = messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
  const isLargeContext = totalPromptChars > 50_000 && isGeminiAvailable();

  const groqApiKey = process.env.GROQ_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  // Function to call Gemini
  async function callGemini(): Promise<string | null> {
    if (!isGeminiAvailable() || !geminiApiKey) return null;
    const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    try {
      console.log(`[ai-client] Calling Google Gemini API (model: ${geminiModel}, promptChars: ${totalPromptChars})...`);
      const systemMessages = messages.filter((m) => m.role === "system");
      const conversationMessages = messages.filter((m) => m.role !== "system");

      const systemInstruction = systemMessages.length > 0
        ? { parts: systemMessages.map((m) => ({ text: m.content || "" })) }
        : undefined;

      const contents = conversationMessages
        .filter((m) => Boolean(m.content && m.content.trim()))
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content || "" }],
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
          console.log(`[ai-client] Gemini response received successfully`);
          return text;
        }
      } else {
        const errorText = await res.text();
        console.warn(`[ai-client] Gemini API returned status ${res.status}: ${errorText.slice(0, 180)}...`);

        // Check if daily free tier quota was hit (20 reqs/day)
        if (res.status === 429 && (errorText.includes("RESOURCE_EXHAUSTED") || errorText.includes("Quota exceeded"))) {
          geminiExhaustedUntil = Date.now() + 60 * 60 * 1000; // Trip breaker for 1 hour
          console.warn(`[ai-client] 🛑 Google Gemini free tier daily quota exhausted. Tripping circuit breaker for 1 hour — all requests will route to Groq.`);
        }
      }
    } catch (err) {
      console.warn(`[ai-client] Gemini API request failed:`, err);
    }
    return null;
  }

  // Function to call Groq with retry-after backoff and multi-model fallback
  async function callGroq(): Promise<string | null> {
    if (!groqApiKey) return null;
    const primaryModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    const candidateModels = Array.from(new Set([primaryModel, "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]));

    for (let modelIdx = 0; modelIdx < candidateModels.length; modelIdx++) {
      const currentModel = candidateModels[modelIdx];
      let retryCount = 0;
      const maxRetries = 1;

      while (retryCount <= maxRetries) {
        try {
          console.log(
            `[ai-client] Calling Groq API (model: ${currentModel}, promptChars: ${totalPromptChars}${retryCount > 0 ? `, retry ${retryCount}` : ""})...`
          );
          const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${groqApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: currentModel,
              messages,
              temperature,
              ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
            }),
          });

          if (res.ok) {
            const data = await res.json();
            const content = data.choices?.[0]?.message?.content;
            if (content) {
              console.log(`[ai-client] Groq ${currentModel} response received successfully`);
              return content;
            }
          } else {
            const errorText = await res.text();
            console.warn(
              `[ai-client] Groq API returned status ${res.status} on ${currentModel}: ${errorText.slice(0, 180)}...`
            );

            // Handle 429 Token Bucket limits intelligently
            if (res.status === 429) {
              const retryAfterHeader = res.headers.get("retry-after");
              const delayMs = parseRetryDelayMs(errorText, retryAfterHeader);

              if (retryCount < maxRetries) {
                console.log(
                  `[ai-client] ⏳ Groq TPM limit hit on ${currentModel}. Waiting ${(delayMs / 1000).toFixed(1)}s for token replenishment...`
                );
                await new Promise((r) => setTimeout(r, delayMs));
                retryCount++;
                continue; // Retry with replenished tokens
              } else {
                console.log(
                  `[ai-client] ⚡ Groq 429 persisted on ${currentModel} — falling back to next high-throughput model...`
                );
                break; // Break inner retry loop to try next candidate model
              }
            } else if (res.status === 400 && errorText?.includes("json_validate_failed")) {
              console.log(`[ai-client] 🔄 Groq json_validate_failed on ${currentModel} — retrying prompt in relaxed JSON mode...`);
              try {
                const retryRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${groqApiKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    model: currentModel,
                    messages,
                    temperature,
                  }),
                });
                if (retryRes.ok) {
                  const retryData = await retryRes.json();
                  const content = retryData.choices?.[0]?.message?.content;
                  if (content) {
                    console.log(`[ai-client] Groq ${currentModel} relaxed response received successfully`);
                    return content;
                  }
                }
              } catch {
                // fall through to next candidate model
              }
              break;
            } else {
              break;
            }
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[ai-client] Groq API request failed on ${currentModel}:`, errMsg);
          if (retryCount < maxRetries) {
            await new Promise((r) => setTimeout(r, 600));
            retryCount++;
            continue;
          }
          break;
        }
      }
    }
    return null;
  }

  // Routing Strategy:
  if (preferredProvider === "gemini" || (preferredProvider === "auto" && isLargeContext)) {
    if (isLargeContext) {
      console.log(`[ai-client] Large context (${totalPromptChars} chars) — prioritizing Gemini.`);
    }
    const geminiRes = await callGemini();
    if (geminiRes) return geminiRes;

    console.log(`[ai-client] Gemini attempt unsuccessful, attempting Groq fallback...`);
    const groqRes = await callGroq();
    if (groqRes) return groqRes;
  } else {
    // Standard fast path (Groq primary, Gemini fallback only if healthy)
    const groqRes = await callGroq();
    if (groqRes) return groqRes;

    if (isGeminiAvailable()) {
      console.log(`[ai-client] Groq attempt unsuccessful, attempting Gemini fallback...`);
      const geminiRes = await callGemini();
      if (geminiRes) return geminiRes;
    }
  }

  console.warn(`[ai-client] Both Groq and Gemini calls were exhausted with no valid response.`);
  return "";
}
