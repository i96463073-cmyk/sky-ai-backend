// ============================================
// SKY AI — News Filter Brain
// ============================================

const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-1.5-flash"];
const GROQ_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
const CF_MODELS = ["@cf/meta/llama-3.1-8b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

function hash(value) {
  let h = 0;
  for (let i = 0; i < String(value).length; i++) {
    h = ((h << 5) - h) + String(value).charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

function getKeys(plural, singular) {
  const raw = String(plural || "").trim();
  if (raw) return [...new Set(raw.split(",").map(k => k.trim()).filter(Boolean))];
  return singular ? [String(singular).trim()].filter(Boolean) : [];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================
// PROVIDERS (Gemini, Groq, Cloudflare)
// ============================================
async function geminiChat(key, req) {
  for (const model of GEMINI_MODELS) {
    try {
      const response = await fetchWithTimeout(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: req.messages, temperature: 0.1, max_tokens: 1000, tools: req.tools })
        }
      );
      if (!response.ok) continue;
      const data = await response.json();
      if (data.choices?.[0]?.message) return { ok: true, message: data.choices[0].message };
    } catch (e) {}
  }
  return { ok: false, error: "Gemini failed" };
}

async function groqChat(key, req) {
  for (const model of GROQ_MODELS) {
    try {
      const response = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: req.messages, temperature: 0.1, max_tokens: 1000, tools: req.tools })
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (data.choices?.[0]?.message) return { ok: true, message: data.choices[0].message };
    } catch (e) {}
  }
  return { ok: false, error: "Groq failed" };
}

async function cfChat(env, req) {
  if (!env.AI) return { ok: false, error: "No CF AI" };
  for (const model of CF_MODELS) {
    try {
      const response = await env.AI.run(model, { messages: req.messages, tools: req.tools });
      if (response?.response) return { ok: true, message: { role: "assistant", content: response.response } };
    } catch (e) {}
  }
  return { ok: false, error: "CF failed" };
}

// ============================================
// CORE AGENT LOOP
// ============================================
export async function runAgent(env, userId, userMessage) {
  const tools = [
    { type: "function", function: {
      name: "web_search",
      description: "Search the web for current Forex news and economic calendars.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }}
  ];

  const systemPrompt = `You are Sky, an elite Forex News and Sentiment Filter.
Current Time: ${new Date().toUTCString()}

Your ONLY job is to check if there is high-impact news (FOMC, NFP, CPI, Central Bank speeches) in the next 2 hours that would invalidate the requested trade.
Use the web_search tool to verify.
You MUST reply with ONLY a valid JSON object. Do not include markdown formatting like \`\`\`json.
Format: {"recommendation": "APPROVE" | "BLOCK", "reason": "Short explanation."}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];

  let result = { ok: false };

  // 1. Try Gemini
  const gKeys = getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY);
  for (const key of gKeys) {
    result = await geminiChat(key, { messages, tools });
    if (result.ok) break;
  }

  // 2. Try Groq
  if (!result.ok) {
    const groqKeys = getKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY);
    for (const key of groqKeys) {
      result = await groqChat(key, { messages, tools });
      if (result.ok) break;
    }
  }

  // 3. Try Cloudflare
  if (!result.ok) {
    result = await cfChat(env, { messages, tools });
  }

  if (!result.ok) return { reply: '{"recommendation": "BLOCK", "reason": "All AI providers failed."}' };

  const msg = result.message;
  const calls = msg.tool_calls || [];

  // Handle Tool Calls (Web Search)
  if (calls.length > 0) {
    for (const call of calls) {
      if (call.function.name === "web_search") {
        const args = JSON.parse(call.function.arguments);
        let searchResult = "No news found.";
        
        try {
           const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
             headers: { "User-Agent": "Mozilla/5.0" }
           });
           const html = await res.text();
           // Very basic extraction of text from DuckDuckGo
           searchResult = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000);
        } catch (e) {}

        messages.push(msg);
        messages.push({ role: "tool", tool_call_id: call.id, content: searchResult });
        
        // Ask AI to analyze the search results
        let finalResult = { ok: false };
        for (const key of gKeys) {
           finalResult = await geminiChat(key, { messages });
           if (finalResult.ok) break;
        }
        if (finalResult.ok) return { reply: finalResult.message.content };
      }
    }
  }

  return { reply: msg.content || '{"recommendation": "BLOCK", "reason": "No response."}' };
}

// Legacy fetch handler (keeps your /chat route working)
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
    const url = new URL(request.url);
    if (url.pathname === "/chat" && request.method === "POST") {
      const body = await request.json();
      const result = await runAgent(env, "user", body.message);
      return json(result, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    }
    return json({ error: "Not found" }, { "Content-Type": "application/json" }, 404);
  }
};
