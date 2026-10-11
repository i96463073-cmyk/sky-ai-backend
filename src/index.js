// ============================================
// SKY AI — v0.14.3
// Sequential fallback + working models + no deploy break
// ============================================

const VERSION = "0.14.3";

// Try each Gemini model in order until one works
const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
];

// Real Cloudflare AI models (try in order)
const CF_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwen1.5-14b-chat-awq"
];

const GROQ_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b"
];

const REPO = "i96463073-cmyk/Sky";
const HISTORY_LIMIT = 6;
const MEMORY_LIMIT = 20;
const MAX_TOOL_CALLS_PER_TURN = 12;
const MAX_ITER_SMALL = 8;
const MAX_ITER_BIG = 16;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json; charset=UTF-8"
    };

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/")
        return json({ service: "Sky AI", version: VERSION, status: "online" }, cors);

      if (url.pathname === "/health")
        return json({
          ok: true,
          service: "Sky AI",
          version: VERSION,
          gemini_keys: getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY).length,
          groq_keys: getKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY).length,
          cloudflare_ai: !!env.AI,
          memory: !!env.SKY_MEMORY,
          github: !!env.GITHUB_TOKEN,
          now: new Date().toISOString()
        }, cors);

      if (url.pathname === "/brains")
        return json({
          version: VERSION,
          gemini_models: GEMINI_MODELS,
          groq_models: GROQ_MODELS,
          cf_models: CF_MODELS,
          gemini_keys: getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY).length,
          groq_keys: getKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY).length,
          cloudflare_ai: !!env.AI,
          strategy: "sequential fallback with per-key cooldown"
        }, cors);

      if (url.pathname === "/chat" && request.method === "POST") {
        const body = await request.json();
        const message = String(body.message || "").trim();
        if (!message) return json({ error: "Missing message" }, cors, 400);

        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const userId = "u_" + hash(ip);
        return json(await runAgent(env, userId, message), cors);
      }

      if (url.pathname === "/vision" && request.method === "POST")
        return await handleVision(request, env, cors);

      if (url.pathname === "/deploy" && request.method === "POST")
        return await handleDeploy(request, env, cors);

      return json({ error: "Not found" }, cors, 404);
    } catch (error) {
      return json({
        error: String(error).slice(0, 250),
        reply: "The request failed. Check the backend logs and try again.",
        action: null
      }, cors, 500);
    }
  }
};

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

async function pickKey(env, provider, keys) {
  for (const key of keys || []) {
    if (!env.SKY_MEMORY) return key;
    try {
      const cooldown = await env.SKY_MEMORY.get("cooldown:" + provider + ":" + hash(key));
      if (!cooldown) return key;
    } catch {
      return key;
    }
  }
  return null;
}

async function markCooldown(env, provider, key, seconds = 60) {
  if (!env.SKY_MEMORY || !key) return;
  try {
    await env.SKY_MEMORY.put(
      "cooldown:" + provider + ":" + hash(key),
      "1",
      { expirationTtl: Math.max(30, Math.min(seconds, 900)) }
    );
  } catch {}
}

async function withRetry(provider, env, fn, key = null) {
  const cooldownKey = key
    ? "cooldown:" + provider + ":" + hash(key)
    : null;

  if (cooldownKey && env.SKY_MEMORY) {
    try {
      if (await env.SKY_MEMORY.get(cooldownKey))
        return { ok: false, error: provider + " key cooling down" };
    } catch {}
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fn();
      if (result?.ok) return result;

      const error = String(result?.error || "Provider failed");
      const match = error.match(/\b(400|401|403|404|408|413|422|429|500|502|503|504)\b/);
      const status = match ? Number(match[1]) : 0;

      if ([400, 401, 403, 404, 413, 422].includes(status)) return result;

      if (status === 429 || /rate.?limit|too many requests/i.test(error)) {
        if (key) await markCooldown(env, provider, key, 60);
        return result;
      }

      if (attempt === 0) {
        await sleep(350);
        continue;
      }
      return result || { ok: false, error };
    } catch (error) {
      if (attempt === 0) {
        await sleep(350);
        continue;
      }
      return { ok: false, error: String(error).slice(0, 250) };
    }
  }
  return { ok: false, error: provider + " failed after retries" };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================
// GEMINI — tries each model until one works
// ============================================
async function geminiChat(key, req) {
  const errors = [];

  for (const model of GEMINI_MODELS) {
    try {
      const body = {
        model,
        messages: req.messages,
        temperature: req.temperature ?? 0.5,
        max_tokens: req.max_tokens ?? 3000
      };

      if (req.tools?.length) {
        body.tools = req.tools;
        body.tool_choice = "auto";
      }

      const response = await fetchWithTimeout(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        }
      );

      if (!response.ok) {
        const errText = (await response.text()).slice(0, 220);
        errors.push(model + " HTTP " + response.status + ": " + errText);

        // 404 = wrong model, try next
        if (response.status === 404) continue;
        // 429 = rate limit, don't waste other models
        if (response.status === 429) {
          return { ok: false, error: "Gemini rate limit: " + errText };
        }
        // Other errors — try next model anyway
        continue;
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;
      if (message) return { ok: true, message, model };

      errors.push(model + ": no message");
    } catch (error) {
      errors.push(model + ": " + String(error).slice(0, 120));
    }
  }

  return { ok: false, error: "All Gemini models failed: " + errors.join(" | ") };
}

// ============================================
// GROQ — tries each model in order
// ============================================
async function groqRotate(key, req) {
  const errors = [];

  for (const model of GROQ_MODELS) {
    const result = await groqCall(key, {
      model,
      messages: req.messages,
      ...(req.tools?.length
        ? { tools: req.tools, tool_choice: "auto" }
        : {}),
      temperature: req.temperature ?? 0.5,
      max_tokens: req.max_tokens ?? 3000
    });

    if (result.ok) return { ...result, model };

    errors.push(model + ": " + String(result.error || "").slice(0, 120));

    // Auth failure — no point trying another model
    const match = String(result.error || "").match(/\b(400|401|403|404|413|422)\b/);
    if (match && [401, 403].includes(Number(match[1]))) break;
  }

  return { ok: false, error: "Groq models exhausted: " + errors.join(" | ") };
}

async function groqCall(key, body) {
  try {
    const response = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok)
      return {
        ok: false,
        error: "Groq HTTP " + response.status + ": " +
          (await response.text()).slice(0, 220)
      };

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    return message ? { ok: true, message } : { ok: false, error: "Groq returned no message" };
  } catch (error) {
    return { ok: false, error: "Groq: " + String(error).slice(0, 200) };
  }
}

// ============================================
// CLOUDFLARE AI — tries each model in order
// ============================================
async function cfAICall(env, req) {
  if (!env.AI) return { ok: false, error: "Cloudflare AI binding missing" };

  const errors = [];

  for (const model of CF_MODELS) {
    try {
      const response = await env.AI.run(model, {
        messages: req.messages,
        max_tokens: Math.min(req.max_tokens ?? 2000, 3000),
        ...(req.tools?.length
          ? { tools: req.tools, tool_choice: "auto" }
          : {})
      });

      if (response?.choices?.[0]?.message)
        return { ok: true, message: response.choices[0].message, model };

      if (response?.tool_calls?.length)
        return {
          ok: true,
          message: {
            role: "assistant",
            content: response.response || "",
            tool_calls: response.tool_calls
          },
          model
        };

      if (typeof response?.response === "string")
        return { ok: true, message: { role: "assistant", content: response.response }, model };

      if (typeof response === "string")
        return { ok: true, message: { role: "assistant", content: response }, model };

      errors.push(model + ": unexpected response");
    } catch (error) {
      errors.push(model + ": " + String(error).slice(0, 120));
    }
  }

  return { ok: false, error: "All CF models failed: " + errors.join(" | ") };
}

// ============================================
// MASTER AI CALLER — sequential fallback
// ============================================
async function callAI(env, req) {
  const errors = [];

  // 1. Gemini
  const geminiKeys = getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY);
  for (const key of geminiKeys) {
    const result = await withRetry(
      "gemini", env, () => geminiChat(key, req), key
    );
    if (result.ok) {
      result.brain = "gemini";
      return result;
    }
    errors.push(String(result.error || "Gemini failed").slice(0, 150));
  }

  // 2. Groq
  const groqKeys = getKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY);
  for (const key of groqKeys) {
    const result = await withRetry(
      "groq", env, () => groqRotate(key, req), key
    );
    if (result.ok) {
      result.brain = "groq";
      return result;
    }
    errors.push(String(result.error || "Groq failed").slice(0, 150));
  }

  // 3. Cloudflare AI
  if (env.AI) {
    const result = await withRetry("cloudflare", env, () => cfAICall(env, req));
    if (result.ok) {
      result.brain = "cloudflare";
      return result;
    }
    errors.push(String(result.error || "Cloudflare failed").slice(0, 150));
  }

  return {
    ok: false,
    error: "All AI providers failed: " + (errors.join(" | ") || "No providers configured")
  };
}

// ============================================
// PROMPT
// ============================================
function buildPrompt(facts, history) {
  const now = new Date();
  const localTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(now);

  return `You are Sky, an Android AI assistant that can use tools.

Kenya time: ${localTime}
Memory: ${(facts || []).slice(-MEMORY_LIMIT).join("; ") || "none"}
Recent conversation:
${(history || []).slice(-HISTORY_LIMIT).map(m =>
  m.role + ": " + String(m.content || "").slice(0, 300)
).join("\n") || "none"}

Act first — do not ask for confirmation unless the target or intent is truly impossible to guess,
or the action is destructive (payments, deletions, calls to strangers).

Use TAP (not VISION_TAP) for known apps like Facebook, Instagram, WhatsApp — those buttons
are visible in the accessibility tree.

Facebook recipes:
- "Like 3 photos on Facebook": OPEN_APP facebook → WAIT 4000 → TAP Like → WAIT → SCROLL_DOWN → TAP Like → WAIT → SCROLL_DOWN → TAP Like
- "Post <text> on Facebook": OPEN_APP facebook → WAIT 4000 → TAP "What's on your mind" → WAIT 2000 → TYPE <text> → TAP Post
- "Comment <text> on Facebook": OPEN_APP facebook → WAIT 4000 → TAP Comment → TAP "Write a comment" → TYPE <text> → TAP Post

Instagram: same pattern using TAP Like.

WhatsApp: WHATSAPP_MESSAGE to+message → WAIT → TAP Send.

Keep replies to 1-3 sentences. No markdown tables or code fences.`;
}

// ============================================
// AGENT LOOP
// ============================================
async function runAgent(env, userId, userMessage) {
  let facts = [];
  let history = [];

  if (env.SKY_MEMORY) {
    try {
      facts = JSON.parse(await env.SKY_MEMORY.get(userId + ":facts") || "[]");
      history = JSON.parse(await env.SKY_MEMORY.get(userId + ":history") || "[]");
    } catch {}
  }

  if (/^(remember|note)[: ]/i.test(userMessage)) {
    const fact = userMessage.replace(/^(remember|note)[: ]/i, "").trim();
    if (fact) {
      facts.push(fact);
      facts = facts.slice(-MEMORY_LIMIT);
      if (env.SKY_MEMORY)
        await env.SKY_MEMORY.put(userId + ":facts", JSON.stringify(facts));
      return { reply: "Got it. I'll remember that.", action: null, actions: [] };
    }
  }

  if (/^forget everything/i.test(userMessage)) {
    if (env.SKY_MEMORY)
      await env.SKY_MEMORY.put(userId + ":facts", "[]");
    return { reply: "Saved memories cleared.", action: null, actions: [] };
  }

  const tools = [
    { type: "function", function: {
      name: "web_search",
      description: "Search the web for current information.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }},
    { type: "function", function: {
      name: "read_url",
      description: "Read public webpage text.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
    }},
    { type: "function", function: {
      name: "research",
      description: "Search and read several pages about a topic.",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] }
    }},
    { type: "function", function: {
      name: "phone_action",
      description: "Queue a supported action for the connected Android app to execute.",
      parameters: {
        type: "object",
        properties: {
          action_type: {
            type: "string",
            enum: ["OPEN_APP","SEARCH_WEB","WHATSAPP_MESSAGE","SEND_SMS","TAP",
              "VISION_TAP","TYPE","READ_SCREEN","READ_SCREEN_VISION","GO_BACK",
              "GO_HOME","SCROLL_DOWN","SCROLL_UP","WAIT"]
          },
          query: { type: "string" },
          to: { type: "string" },
          message: { type: "string" },
          target: { type: "string" },
          text: { type: "string" },
          ms: { type: "number" },
          say: { type: "string" }
        },
        required: ["action_type", "say"]
      }
    }},
    { type: "function", function: {
      name: "remember",
      description: "Save a useful user-approved fact.",
      parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] }
    }},
    { type: "function", function: {
      name: "read_own_file",
      description: "Read a file from the Sky GitHub repository.",
      parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] }
    }},
    { type: "function", function: {
      name: "propose_code_change",
      description: "Prepare a code proposal for user review; do not deploy it.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          summary: { type: "string" },
          new_content: { type: "string" }
        },
        required: ["file_path", "summary", "new_content"]
      }
    }}
  ];

  const messages = [
    { role: "system", content: buildPrompt(facts, history) },
    ...history.slice(-HISTORY_LIMIT),
    { role: "user", content: userMessage }
  ];

  const actions = [];
  let codeProposal = null;
  let lastBrain = "unknown";
  let toolCount = 0;

  // Use big-task limit for complex requests
  const isBigTask = /research|analyze|compare|deep|every|all|complete|facebook|instagram|like|post|comment/i.test(userMessage);
  const maxIterations = isBigTask ? MAX_ITER_BIG : MAX_ITER_SMALL;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const result = await callAI(env, {
      messages,
      tools,
      temperature: 0.4,
      max_tokens: 3000
    });

    if (!result.ok) {
      return {
        reply: String(result.error || "All AI providers failed").slice(0, 400),
        action: actions[0] || null,
        actions,
        code_proposal: codeProposal,
        brain: lastBrain
      };
    }

    lastBrain = result.brain || "unknown";
    const message = result.message;
    const calls = message.tool_calls || [];

    if (!calls.length) {
      const reply = String(message.content || "Okay.").trim();
      await saveHist(env, userId, history, userMessage, reply);
      return {
        reply,
        action: actions[0] || null,
        actions,
        code_proposal: codeProposal,
        brain: lastBrain
      };
    }

    messages.push({
      role: "assistant",
      content: message.content || "",
      tool_calls: calls
    });

    for (const call of calls) {
      if (++toolCount > MAX_TOOL_CALLS_PER_TURN) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: "Tool call limit reached" })
        });
        continue;
      }

      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {}

      const name = call.function?.name;
      let output = {};

      try {
        if (name === "web_search") {
          output = await multiSearch(env, String(args.query || userMessage), 5);
        } else if (name === "read_url") {
          output = await fetchPageText(String(args.url || ""));
        } else if (name === "research") {
          output = await deepResearch(env, String(args.topic || userMessage), 3);
        } else if (name === "phone_action") {
          const type = String(args.action_type || "");
          const allowed = ["OPEN_APP","SEARCH_WEB","WHATSAPP_MESSAGE","SEND_SMS",
            "TAP","VISION_TAP","TYPE","READ_SCREEN","READ_SCREEN_VISION",
            "GO_BACK","GO_HOME","SCROLL_DOWN","SCROLL_UP","WAIT"];

          if (!allowed.includes(type)) {
            output = { error: "Unsupported phone action" };
          } else {
            const action = { type };
            for (const field of ["query","to","message","target","text","say"]) {
              if (typeof args[field] === "string") action[field] = args[field];
            }
            if (typeof args.ms === "number")
              action.ms = Math.max(0, Math.min(args.ms, 10000));

            actions.push(action);
            output = { queued: true, action };
          }
        } else if (name === "remember") {
          const fact = String(args.fact || "").trim();
          if (fact) {
            facts.push(fact);
            facts = facts.slice(-MEMORY_LIMIT);
            if (env.SKY_MEMORY)
              await env.SKY_MEMORY.put(userId + ":facts", JSON.stringify(facts));
          }
          output = { saved: !!fact };
        } else if (name === "read_own_file") {
          output = await readOwnFile(env, String(args.file_path || ""));
        } else if (name === "propose_code_change") {
          const filePath = String(args.file_path || "").trim();
          const content = String(args.new_content || "");
          if (!filePath || content.length > 50000) {
            output = { error: "Invalid path or proposal too large" };
          } else {
            codeProposal = {
              file_path: filePath,
              summary: String(args.summary || "Code change"),
              new_content: content
            };
            output = { proposed: true, approval_required: true };
          }
        } else {
          output = { error: "Unknown tool" };
        }
      } catch (error) {
        output = { error: String(error).slice(0, 250) };
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(output).slice(0, 10000)
      });
    }
  }

  const reply = codeProposal
    ? "I've prepared a code proposal for review. It has not been deployed."
    : "I've reached the tool-call limit for this turn. You can ask me to continue.";

  await saveHist(env, userId, history, userMessage, reply);

  return {
    reply,
    action: actions[0] || null,
    actions,
    code_proposal: codeProposal,
    brain: lastBrain,
    incomplete: true
  };
}

async function saveHist(env, userId, history, userMessage, reply) {
  if (!env.SKY_MEMORY) return;
  try {
    const updated = [
      ...history,
      { role: "user", content: userMessage },
      { role: "assistant", content: reply }
    ].slice(-HISTORY_LIMIT);
    await env.SKY_MEMORY.put(userId + ":history", JSON.stringify(updated));
  } catch {}
}

// ============================================
// GITHUB REPO READ
// ============================================
async function readOwnFile(env, filePath) {
  if (!env.GITHUB_TOKEN) return { error: "GitHub token not configured" };

  const safePath = safeRepoPath(filePath);
  if (!safePath) return { error: "Invalid repository file path" };

  try {
    const response = await fetchWithTimeout(
      "https://api.github.com/repos/" + REPO + "/contents/" +
        safePath.split("/").map(encodeURIComponent).join("/"),
      {
        headers: {
          "Authorization": "Bearer " + env.GITHUB_TOKEN,
          "Accept": "application/vnd.github+json",
          "User-Agent": "SkyAI"
        }
      }
    );

    if (!response.ok)
      return { error: "GitHub HTTP " + response.status };

    const data = await response.json();
    const decoded = decodeURIComponent(escape(atob(
      String(data.content || "").replace(/\n/g, "")
    )));
    const lines = decoded.split("\n");

    return {
      file_path: safePath,
      line_count: lines.length,
      content: lines.slice(0, 120).join("\n").slice(0, 12000)
    };
  } catch (error) {
    return { error: String(error).slice(0, 200) };
  }
}

function safeRepoPath(path) {
  const value = String(path || "").trim().replace(/^\/+/, "");
  if (!value || value.includes("..") || value.includes("\\") ||
      value.startsWith(".git/") || value.includes("\0")) return null;
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) return null;
  return value;
}

// ============================================
// VISION
// ============================================
async function handleVision(request, env, cors) {
  const keys = getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY);
  if (!keys.length)
    return json({ error: "No Gemini API key configured" }, cors, 503);

  const body = await request.json();
  const image = String(body.image || "").trim();
  const target = String(body.target || "").trim();
  const width = Number(body.width || 1080);
  const height = Number(body.height || 2400);

  if (!image || !target)
    return json({ error: "Missing image or target" }, cors, 400);

  const match = image.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
  const imageData = match ? match[2] : image;
  const mimeType = match
    ? (match[1].toLowerCase() === "jpg" ? "image/jpeg" :
       "image/" + match[1].toLowerCase())
    : "image/jpeg";

  const prompt =
    `Screenshot dimensions ${width}x${height}. Locate this UI element: "${target}". ` +
    `Return only JSON with found, x, y, and label. Coordinates must be pixel coordinates ` +
    `from the top-left. If uncertain, return {"found":false}.`;

  const errors = [];
  for (const key of keys) {
    const available = await pickKey(env, "gemini", [key]);
    if (!available) continue;

    for (const model of GEMINI_MODELS) {
      try {
        const response = await fetchWithTimeout(
          "https://generativelanguage.googleapis.com/v1beta/models/" +
            encodeURIComponent(model) +
            ":generateContent?key=" + encodeURIComponent(key),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: prompt },
                  { inline_data: { mime_type: mimeType, data: imageData } }
                ]
              }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
            })
          }
        );

        if (!response.ok) {
          const error = "HTTP " + response.status;
          errors.push(model + ": " + error);
          if (response.status === 429) {
            await markCooldown(env, "gemini", key, 60);
            break;
          }
          if (response.status === 404) continue;
          break;
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");

        if (start < 0 || end < start)
          return json({ found: false }, cors);

        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          if (typeof parsed.found !== "boolean")
            return json({ found: false }, cors);
          return json(parsed, cors);
        } catch {
          return json({ found: false }, cors);
        }
      } catch (error) {
        errors.push(model + ": " + String(error).slice(0, 100));
      }
    }
  }

  return json({
    error: "Vision providers failed",
    details: errors.slice(0, 3)
  }, cors, 502);
}

// ============================================
// DEPLOYMENT
// ============================================
async function handleDeploy(request, env, cors) {
  if (!env.GITHUB_TOKEN)
    return json({ error: "GitHub token not configured" }, cors, 503);

  // Optional: require secret if DEPLOY_SECRET is set
  if (env.DEPLOY_SECRET) {
    const authorization = request.headers.get("Authorization") || "";
    const supplied = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!constantTimeEqual(supplied, env.DEPLOY_SECRET))
      return json({ error: "Unauthorized" }, cors, 401);
  }

  const body = await request.json();
  const filePath = safeRepoPath(body.file_path);
  const content = String(body.new_content || "");
  const commitMessage = String(body.commit_message || "Sky AI: approved update").trim();

  if (!filePath || !content)
    return json({ error: "Missing or invalid file_path/new_content" }, cors, 400);

  if (content.length > 100000)
    return json({ error: "File content exceeds the 100 KB limit" }, cors, 413);

  const today = new Date().toISOString().slice(0, 10);
  const rateKey = "deploys:" + today;
  let count = 0;

  if (env.SKY_MEMORY) {
    try {
      count = Number(await env.SKY_MEMORY.get(rateKey) || 0);
    } catch {}
  }

  if (count >= 10)
    return json({ error: "Daily deployment limit reached" }, cors, 429);

  try {
    const apiUrl = "https://api.github.com/repos/" + REPO +
      "/contents/" + filePath.split("/").map(encodeURIComponent).join("/");

    const headers = {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "User-Agent": "SkyAI"
    };

    const getResponse = await fetchWithTimeout(apiUrl, { headers });
    let sha = null;

    if (getResponse.ok) {
      sha = (await getResponse.json()).sha;
    } else if (getResponse.status !== 404) {
      return json({ error: "GitHub read HTTP " + getResponse.status }, cors, 502);
    }

    const encoded = btoa(unescape(encodeURIComponent(content)));
    const putBody = {
      message: commitMessage.slice(0, 150),
      content: encoded,
      branch: "main"
    };
    if (sha) putBody.sha = sha;

    const putResponse = await fetchWithTimeout(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(putBody)
    });

    if (!putResponse.ok)
      return json({
        error: "GitHub write HTTP " + putResponse.status,
        details: (await putResponse.text()).slice(0, 200)
      }, cors, 502);

    const result = await putResponse.json();

    if (env.SKY_MEMORY) {
      try {
        await env.SKY_MEMORY.put(rateKey, String(count + 1), {
          expirationTtl: 86400
        });
      } catch {}
    }

    return json({
      ok: true,
      file_path: filePath,
      commit: result.commit?.sha,
      message: "GitHub commit created"
    }, cors);
  } catch (error) {
    return json({ error: String(error).slice(0, 250) }, cors, 500);
  }
}

function constantTimeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============================================
// WEB SEARCH
// ============================================
async function multiSearch(env, query, maxResults = 5) {
  const results = await Promise.all([
    ddgSearch(query, maxResults).catch(() => ({ results: [] })),
    bingSearch(query, maxResults).catch(() => ({ results: [] })),
    wikiSearch(query).catch(() => ({ results: [] })),
    tavily(env, query).catch(() => ({ results: [] }))
  ]);

  const combined = [];
  const seen = new Set();

  for (let i = 0; i < results.length; i++) {
    const source = ["duckduckgo", "bing", "wikipedia", "tavily"][i];
    for (const item of results[i].results || []) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      combined.push({
        title: item.title || "",
        url: item.url,
        snippet: String(item.snippet || "").slice(0, 400),
        source
      });
      if (combined.length >= maxResults) break;
    }
    if (combined.length >= maxResults) break;
  }

  return { query, count: combined.length, results: combined };
}

async function ddgSearch(query, limit = 5) {
  try {
    const response = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0"
      },
      body: new URLSearchParams({ q: query }).toString()
    }, 12000);

    if (!response.ok) return { results: [] };
    return { results: parseDDG(await response.text(), limit) };
  } catch {
    return { results: [] };
  }
}

function parseDDG(html, limit) {
  const output = [];
  const blocks = html.split(/<div class="result[^"]*"[^>]*>/);

  for (let i = 1; i < blocks.length && output.length < limit; i++) {
    const block = blocks[i];
    const link = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/is);
    const snippet = block.match(/class="result__snippet"[^>]*>(.*?)<\/a>/is);
    if (!link) continue;

    let url = link[1];
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) {
      try { url = decodeURIComponent(redirect[1]); } catch {}
    }

    const title = stripTags(link[2]);
    if (url.startsWith("http") && title)
      output.push({ title, url, snippet: snippet ? stripTags(snippet[1]) : "" });
  }
  return output;
}

async function bingSearch(query, limit = 5) {
  try {
    const response = await fetchWithTimeout(
      "https://www.bing.com/search?q=" + encodeURIComponent(query) + "&count=" + limit,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      12000
    );

    if (!response.ok) return { results: [] };
    const html = await response.text();
    const results = [];
    const blocks = html.split(/<li class="b_algo"/);

    for (let i = 1; i < blocks.length && results.length < limit; i++) {
      const link = blocks[i].match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/is);
      const snippet = blocks[i].match(/<p[^>]*>(.*?)<\/p>/is);
      if (!link) continue;

      const title = stripTags(link[2]);
      if (link[1].startsWith("http") && title)
        results.push({
          title,
          url: link[1],
          snippet: snippet ? stripTags(snippet[1]) : ""
        });
    }
    return { results };
  } catch {
    return { results: [] };
  }
}

async function wikiSearch(query) {
  try {
    const url = "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
      encodeURIComponent(query) + "&format=json&srlimit=3&srprop=snippet";
    const response = await fetchWithTimeout(url, {
      headers: { "User-Agent": "SkyAI/0.14" }
    }, 12000);

    if (!response.ok) return { results: [] };
    const data = await response.json();

    return {
      results: (data.query?.search || []).map(item => ({
        title: item.title,
        url: "https://en.wikipedia.org/wiki/" +
          encodeURIComponent(item.title.replace(/ /g, "_")),
        snippet: stripTags(item.snippet || "")
      }))
    };
  } catch {
    return { results: [] };
  }
}

function stripTags(value) {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPageText(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol))
      return { error: "Only HTTP and HTTPS URLs are supported" };

    const response = await fetchWithTimeout(parsed.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SkyAI/0.14)" },
      redirect: "follow"
    }, 12000);

    if (!response.ok) return { error: "HTTP " + response.status };

    const html = (await response.text()).slice(0, 500000);
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = titleMatch ? stripTags(titleMatch[1]) : "";

    const text = stripTags(
      html.replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    );

    return { url: parsed.toString(), title, text: text.slice(0, 6000) };
  } catch (error) {
    return { error: String(error).slice(0, 200) };
  }
}

async function deepResearch(env, query, maxPages = 3) {
  const search = await multiSearch(env, query, 6);
  if (!search.results.length)
    return { error: "No search results", pages: [] };

  const pages = [];
  for (const item of search.results.slice(0, maxPages)) {
    const page = await fetchPageText(item.url);
    if (!page.error && page.text)
      pages.push({
        url: item.url,
        title: page.title || item.title,
        text: page.text.slice(0, 1500)
      });
  }

  return {
    query,
    search_results: search.results,
    pages,
    pages_read: pages.length
  };
}

async function tavily(env, query) {
  const keys = getKeys(env.TAVILY_API_KEYS, env.TAVILY_API_KEY);
  if (!keys.length) return { results: [] };

  for (const key of keys) {
    const available = await pickKey(env, "tavily", [key]);
    if (!available) continue;

    try {
      const response = await fetchWithTimeout("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          search_depth: "basic",
          include_answer: true,
          max_results: 5
        })
      }, 12000);

      if (!response.ok) {
        if (response.status === 429) await markCooldown(env, "tavily", key, 60);
        continue;
      }

      const data = await response.json();
      return {
        answer: data.answer || "",
        results: (data.results || []).slice(0, 5).map(item => ({
          title: item.title || "",
          url: item.url || "",
          snippet: String(item.content || "").slice(0, 400)
        }))
      };
    } catch {}
  }

  return { results: [] };
       }
