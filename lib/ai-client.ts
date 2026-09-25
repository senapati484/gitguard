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

/**
 * Generate a chat completion using Sonnet (if specified & key present), Groq (primary for fast diffs),
 * or Gemini (for large contexts >24KB or fallback).
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
  const isLargeContext = totalPromptChars > 10_000;

  const groqApiKey = process.env.GROQ_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  // Function to call Gemini
  async function callGemini(): Promise<string | null> {
    if (!geminiApiKey) return null;
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
        console.warn(`[ai-client] Gemini API returned status ${res.status}: ${errorText}`);
      }
    } catch (err) {
      console.warn(`[ai-client] Gemini API request failed:`, err);
    }
    return null;
  }

  // Function to call Groq
  async function callGroq(): Promise<string | null> {
    if (!groqApiKey) return null;
    const groqModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    try {
      console.log(`[ai-client] Calling Groq API (model: ${groqModel}, promptChars: ${totalPromptChars})...`);
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
          `[ai-client] Groq API returned status ${res.status}: ${errorText}. Attempting fallback...`
        );
      }
    } catch (err) {
      console.warn(`[ai-client] Groq API request failed:`, err);
    }
    return null;
  }

  // Route 1: If large context or explicitly Gemini, try Gemini first
  if (preferredProvider === "gemini" || (preferredProvider === "auto" && isLargeContext && geminiApiKey)) {
    if (isLargeContext) {
      console.log(`[ai-client] Context size (${totalPromptChars} chars) exceeds 22KB — prioritizing Gemini 2.5 Flash (1M context) to prevent Groq TPM rate limits.`);
    }
    const geminiRes = await callGemini();
    if (geminiRes) return geminiRes;

    // Fallback to Groq if Gemini failed
    console.log(`[ai-client] Gemini attempt unsuccessful, attempting Groq fallback...`);
    const groqRes = await callGroq();
    if (groqRes) return groqRes;
  } else {
    // Route 2: Standard fast path (Groq primary, Gemini fallback)
    const groqRes = await callGroq();
    if (groqRes) return groqRes;

    console.log(`[ai-client] Groq attempt unsuccessful, attempting Gemini fallback...`);
    const geminiRes = await callGemini();
    if (geminiRes) return geminiRes;
  }

  console.warn(`[ai-client] Both Groq and Gemini calls were exhausted with no valid response.`);
  return "";
}
