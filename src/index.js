// ============================================
// SKY AI — v0.14.2
// Correct models + retry logic + full action support
// ============================================

const GEMINI_MODEL = "gemini-2.0-flash";
const CF_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const MAX_ITER_SMALL = 10;
const MAX_ITER_BIG = 25;
const HISTORY_LIMIT = 6;
const MEMORY_LIMIT = 20;
const REPO = "i96463073-cmyk/Sky";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================
// RESILIENT CALL WRAPPER
// ============================================
async function withRetry(name, env, fn) {
  if (env.SKY_MEMORY) {
    const cd = await env.SKY_MEMORY.get("cooldown:v2:" + name);
    if (cd) return { ok: false, error: name + " cooling down" };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fn();
      if (result && result.ok) return result;

      const err = String(result?.error || "");

      if (/40[134]/.test(err) || /not found|decommission|invalid|does not exist/i.test(err)) {
        return result;
      }

      if (/429|rate limit/i.test(err)) {
        if (env.SKY_MEMORY) {
          await env.SKY_MEMORY.put("cooldown:v2:" + name, "1", { expirationTtl: 60 });
        }
        return result;
      }

      if (attempt === 0) {
        await sleep(500);
        continue;
      }
      return result;
    } catch (e) {
      if (attempt === 0) {
        await sleep(500);
        continue;
      }
      return { ok: false, error: String(e).slice(0, 200) };
    }
  }
  return { ok: false, error: name + " failed after retries" };
}

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

    if (url.pathname === "/")
      return json({ service: "Sky AI", version: "0.14.2", status: "online" }, cors);

    if (url.pathname === "/brains")
      return json({
        version: "0.14.2",
        brains: {
          gemini_keys: getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY).length,
          groq_keys: getKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY).length,
          cloudflare_ai: !!env.AI
        },
        gemini_model: GEMINI_MODEL,
        groq_models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
        cf_model: CF_MODEL,
        strategy: "retry + cooldown + racing"
      }, cors);

    if (url.pathname === "/health")
      return json({
        ok: true, service: "Sky AI", version: "0.14.2",
        gemini_keys: getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY).length,
        groq_keys: getKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY).length,
        cf_ai: !!env.AI,
        memory: !!env.SKY_MEMORY,
        github: !!env.GITHUB_TOKEN,
        now: new Date().toISOString()
      }, cors);

    if (url.pathname === "/chat" && request.method === "POST") {
      try {
        const body = await request.json();
        const message = String(body.message || "").trim();
        if (!message) return json({ error: "Missing message" }, cors, 400);
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const userId = "u_" + hash(ip);
        const result = await runAgent(env, userId, message);
        return json(result, cors);
      } catch (e) {
        return json({ reply: "Crash: " + String(e).slice(0, 150), action: null }, cors);
      }
    }

    if (url.pathname === "/vision" && request.method === "POST") {
      try {
        const geminiKeys = getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY);
        if (!geminiKeys.length) return json({ error: "No Gemini keys" }, cors, 500);
        const body = await request.json();
        const image = String(body.image || "").trim();
        const target = String(body.target || "").trim();
        const screenW = Number(body.width || 1080);
        const screenH = Number(body.height || 2400);
        if (!image || !target) return json({ error: "Missing fields" }, cors, 400);

        const prompt =
          "Phone screenshot " + screenW + "x" + screenH + " pixels. " +
          "Find UI element matching: \"" + target + "\". " +
          "Reply ONLY valid JSON: " +
          "{\"found\": true, \"x\": 540, \"y\": 1200, \"label\": \"...\"} " +
          "or {\"found\": false}.";

        const key = await pickKey(env, "gemini", geminiKeys);
        if (!key) return json({ error: "All Gemini keys cooling" }, cors, 503);

        const gemRes = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL +
          ":generateContent?key=" + key,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [
                { text: prompt },
                { inline_data: { mime_type: "image/jpeg", data: image } }
              ]}],
              generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
            })
          }
        );

        if (!gemRes.ok) {
          await markCooldown(env, "gemini", key);
          return json({ error: "Gemini " + gemRes.status }, cors, 502);
        }
        const gemData = await gemRes.json();
        const text = (gemData.candidates?.[0]?.content?.parts?.[0]?.text) || "";
        let parsed;
        try {
          const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
          parsed = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
        } catch (e) {
          parsed = { found: false };
        }
        return json(parsed, cors);
      } catch (e) {
        return json({ error: String(e).slice(0, 200) }, cors, 500);
      }
    }

    if (url.pathname === "/deploy" && request.method === "POST") {
      try {
        if (!env.GITHUB_TOKEN) return json({ error: "No GitHub token" }, cors, 500);
        const body = await request.json();
        const filePath = String(body.file_path || "").trim();
        const content = String(body.new_content || "");
        const commitMsg = String(body.commit_message || "SkyAI: auto-update").trim();
        if (!filePath || !content) return json({ error: "Missing fields" }, cors, 400);

        const today = new Date().toISOString().slice(0, 10);
        const rateKey = "deploys:" + today;
        let count = 0;
        if (env.SKY_MEMORY) {
          const v = await env.SKY_MEMORY.get(rateKey);
          count = v ? parseInt(v) : 0;
        }
        if (count >= 10) return json({ error: "Daily limit" }, cors, 429);

        const apiUrl = "https://api.github.com/repos/" + REPO + "/contents/" + filePath;
        const getRes = await fetch(apiUrl, {
          headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "SkyAI" }
        });
        let sha = null;
        if (getRes.ok) {
          const gd = await getRes.json();
          sha = gd.sha;
        }

        const encoded = btoa(unescape(encodeURIComponent(content)));
        const putBody = { message: commitMsg, content: encoded, branch: "main" };
        if (sha) putBody.sha = sha;

        const putRes = await fetch(apiUrl, {
          method: "PUT",
          headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN, "Accept": "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "SkyAI" },
          body: JSON.stringify(putBody)
        });

        if (!putRes.ok) return json({ error: "GitHub " + putRes.status }, cors, 502);
        const putJson = await putRes.json();
        if (env.SKY_MEMORY) await env.SKY_MEMORY.put(rateKey, String(count + 1), { expirationTtl: 86400 });
        return json({ ok: true, commit: putJson.commit?.sha }, cors);
      } catch (e) {
        return json({ error: String(e).slice(0, 200) }, cors, 500);
      }
    }

    return json({ error: "Not found" }, cors, 404);
  }
};

function json(d, cors, status = 200) {
  return new Response(JSON.stringify(d), { status, headers: cors });
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h &= h; }
  return Math.abs(h).toString(36);
}

function getKeys(plural, singular) {
  const raw = (plural || "").trim();
  if (raw) return raw.split(",").map(k => k.trim()).filter(k => k.length > 0);
  if (singular) return [singular];
  return [];
}

async function pickKey(env, provider, keys) {
  if (!keys || keys.length === 0) return null;
  if (!env.SKY_MEMORY) return keys[0];
  for (const key of keys) {
    const cooldownKey = "cooldown:" + provider + ":" + hash(key);
    const val = await env.SKY_MEMORY.get(cooldownKey);
    if (!val) return key;
  }
  return null;
}

async function markCooldown(env, provider, key) {
  if (!env.SKY_MEMORY) return;
  const cooldownKey = "cooldown:" + provider + ":" + hash(key);
  await env.SKY_MEMORY.put(cooldownKey, "1", { expirationTtl: 60 });
}

// ============================================
// GEMINI CALL
// ============================================
async function geminiChat(key, req) {
  try {
    const body = {
      model: GEMINI_MODEL,
      messages: req.messages,
      temperature: req.temperature || 0.5,
      max_tokens: req.max_tokens || 4000
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = "auto";
    }
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: "Gemini " + res.status + ": " + t.slice(0, 200) };
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) return { ok: false, error: "No message" };
    return { ok: true, message: msg };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ============================================
// GROQ CALL (only 2 working models)
// ============================================
async function groqRotate(key, req) {
  const models = [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b"
  ];
  let lastErr = "no groq models";
  for (const m of models) {
    const r = await groqCall(key, {
      model: m,
      messages: req.messages,
      tools: req.tools,
      tool_choice: "auto",
      temperature: req.temperature || 0.5,
      max_tokens: req.max_tokens || 4000
    });
    if (r.ok) return r;
    lastErr = m + ": " + String(r.error || "").slice(0, 120);
    if (r.error && !r.error.toLowerCase().includes("rate")) {
      return { ok: false, error: lastErr };
    }
  }
  return { ok: false, error: "Groq rate-limited. " + lastErr };
}

async function groqCall(key, body) {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: t.slice(0, 300) };
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) return { ok: false, error: "No message" };
    return { ok: true, message: msg };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ============================================
// CLOUDFLARE AI
// ============================================
async function cfAICall(ai, req) {
  try {
    const cfBody = {
      messages: req.messages,
      max_tokens: Math.min(req.max_tokens || 2000, 3000)
    };
    if (req.tools && req.tools.length > 0) cfBody.tools = req.tools;

    const response = await ai.run(CF_MODEL, cfBody);
    let msg = { role: "assistant", content: "" };
    if (response && response.tool_calls && response.tool_calls.length > 0) {
      msg.tool_calls = response.tool_calls;
      msg.content = response.response || "";
    } else if (response && response.response) {
      msg.content = response.response;
    } else if (typeof response === "string") {
      msg.content = response;
    } else {
      msg.content = JSON.stringify(response).slice(0, 500);
    }
    return { ok: true, message: msg };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

// ============================================
// TASK SIZING
// ============================================
function isBigTask(req) {
  let totalChars = 0;
  for (const m of req.messages) {
    if (m.content) totalChars += String(m.content).length;
  }
  if (totalChars > 3500) return true;
  const lastUser = [...req.messages].reverse().find(m => m.role === "user");
  if (lastUser) {
    const text = String(lastUser.content || "").toLowerCase();
    if (/research|analyze|compare|deep|every|all|complete|facebook|instagram|like|post|comment/.test(text)) {
      return true;
    }
  }
  return false;
}

// ============================================
// RACING BRAINS (parallel)
// ============================================
async function raceBrains(env, req) {
  const attempts = [];

  const gk = getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY);
  if (gk.length) {
    const k = await pickKey(env, "gemini", gk);
    if (k) attempts.push(
      withRetry("gemini", env, () => geminiChat(k, req)).then(r => {
        if (!r.ok) return Promise.reject("g:" + String(r.error).slice(0, 80));
        r.brain = "gemini";
        return r;
      })
    );
  }

  const gqk = getKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY);
  if (gqk.length) {
    const k = await pickKey(env, "groq", gqk);
    if (k) attempts.push(
      withRetry("groq", env, () => groqRotate(k, req)).then(r => {
        if (!r.ok) return Promise.reject("q:" + String(r.error).slice(0, 80));
        r.brain = "groq";
        return r;
      })
    );
  }

  if (env.AI) attempts.push(
    withRetry("cloudflare", env, () => cfAICall(env.AI, req)).then(r => {
      if (!r.ok) return Promise.reject("c:" + String(r.error).slice(0, 80));
      r.brain = "cloudflare";
      return r;
    })
  );

  if (attempts.length === 0) return { ok: false, error: "no brains configured" };
  try {
    return await Promise.any(attempts);
  } catch (e) {
    return { ok: false, error: "BRAINS FAILED → " + (e.errors ? e.errors.join(" | ") : String(e)) };
  }
}

// ============================================
// SEQUENTIAL (small tasks)
// ============================================
async function callAI(env, req) {
  if (isBigTask(req)) return await raceBrains(env, req);

  const errors = [];

  const gk = getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY);
  if (gk.length) {
    const k = await pickKey(env, "gemini", gk);
    if (k) {
      const r = await withRetry("gemini", env, () => geminiChat(k, req));
      if (r.ok) { r.brain = "gemini"; return r; }
      errors.push("gemini");
    }
  }

  const gqk = getKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY);
  if (gqk.length) {
    const k = await pickKey(env, "groq", gqk);
    if (k) {
      const r = await withRetry("groq", env, () => groqRotate(k, req));
      if (r.ok) { r.brain = "groq"; return r; }
      errors.push("groq");
    }
  }

  if (env.AI) {
    const r = await withRetry("cloudflare", env, () => cfAICall(env.AI, req));
    if (r.ok) { r.brain = "cloudflare"; return r; }
    errors.push("cloudflare");
  }

  return { ok: false, error: "BRAINS FAILED → " + (errors.join(" | ") || "none configured") };
}

// ============================================
// SYSTEM PROMPT
// ============================================
function buildPrompt(facts, history) {
  const now = new Date();
  const eat = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi", weekday: "short", year: "numeric",
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(now);

  const mem = (facts && facts.length) ? facts.slice(-MEMORY_LIMIT).join("; ") : "none";
  const hist = (history && history.length)
    ? history.slice(-HISTORY_LIMIT).map(m => m.role[0].toUpperCase() + ":" + m.content.slice(0, 80)).join("\n")
    : "none";

  return `You are Sky — an autonomous Android AI agent. You EXECUTE.

Time (Africa/Nairobi): ${eat}
UTC: ${now.toUTCString()}

User memory: ${mem}
Recent:
${hist}

═══ ACT FIRST — NEVER ASK FOR CLARIFICATION ═══

If user says "like the first 3 photos on Facebook":
→ Do it. Open Facebook. Tap Like buttons via TAP action.

Only ask if IMPOSSIBLE to guess OR destructive.

═══ USE TAP (not VISION_TAP) FOR KNOWN APPS ═══

TAP finds buttons by accessibility text — fast, reliable, no screenshots.
VISION_TAP is only fallback when TAP fails.

Facebook: Like="Like", comment="Comment", post="Post", composer="What's on your mind"
Instagram: like="Like", comment="Comment"
WhatsApp: send="Send"

═══ FACEBOOK RECIPES ═══

"Like 3 posts on Facebook":
1. OPEN_APP query:"facebook"
2. WAIT ms:4000
3. TAP target:"Like"
4. WAIT ms:1000
5. SCROLL_DOWN
6. WAIT ms:1500
7. TAP target:"Like"
8. WAIT ms:1000
9. SCROLL_DOWN
10. WAIT ms:1500
11. TAP target:"Like"

"Post on Facebook <text>":
1. OPEN_APP query:"facebook"
2. WAIT ms:4000
3. TAP target:"What's on your mind"
4. WAIT ms:2000
5. TYPE text:"<text>"
6. WAIT ms:1000
7. TAP target:"Post"

"Comment on Facebook <text>":
1. OPEN_APP query:"facebook"
2. WAIT ms:4000
3. TAP target:"Comment"
4. WAIT ms:1500
5. TAP target:"Write a comment"
6. TYPE text:"<text>"
7. TAP target:"Post"

═══ INSTAGRAM ═══

"Like 3 photos on Instagram":
1. OPEN_APP query:"instagram"
2. WAIT ms:4000
3. TAP target:"Like"
4. SCROLL_DOWN, WAIT 1500
5. TAP target:"Like"
6. SCROLL_DOWN, WAIT 1500
7. TAP target:"Like"

═══ WHATSAPP ═══

"Send <text> to <number>":
1. WHATSAPP_MESSAGE to:"<number>" message:"<text>"
2. WAIT ms:2500
3. TAP target:"Send"

═══ TOOLS ═══

web_search, read_url, research, phone_action, remember,
read_own_file, propose_code_change

PHONE ACTIONS:
OPEN_APP(query), SEARCH_WEB(query), WHATSAPP_MESSAGE(to,message),
SEND_SMS(to,message), TAP(target), VISION_TAP(target), TYPE(text),
READ_SCREEN, READ_SCREEN_VISION, GO_BACK, GO_HOME, SCROLL_DOWN,
SCROLL_UP, WAIT(ms)

REPO FILES:
- app/src/main/java/com/sky/agent/MainActivity.kt (TOO BIG)
- app/src/main/java/com/sky/agent/SkyWakeService.kt
- app/src/main/java/com/sky/agent/SkyAccessibilityService.kt
- app/src/main/AndroidManifest.xml
- app/src/main/res/layout/activity_main.xml

RULES:
- Keep replies 1-3 sentences.
- No markdown tables or code fences.`;
}

// ============================================
// AGENT LOOP
// ============================================
async function runAgent(env, userId, userMessage) {
  let facts = [];
  let history = [];
  if (env.SKY_MEMORY) {
    try { const f = await env.SKY_MEMORY.get(userId + ":facts"); if (f) facts = JSON.parse(f); } catch {}
    try { const h = await env.SKY_MEMORY.get(userId + ":history"); if (h) history = JSON.parse(h); } catch {}
  }

  if (/^(remember|note)[: ]/i.test(userMessage)) {
    const fact = userMessage.replace(/^(remember|note)[: ]/i, "").trim();
    if (fact) {
      facts.push(fact);
      if (facts.length > MEMORY_LIMIT) facts = facts.slice(-MEMORY_LIMIT);
      if (env.SKY_MEMORY) await env.SKY_MEMORY.put(userId + ":facts", JSON.stringify(facts));
      return { reply: "Got it.", action: null };
    }
  }
  if (/^forget everything/i.test(userMessage)) {
    if (env.SKY_MEMORY) await env.SKY_MEMORY.put(userId + ":facts", JSON.stringify([]));
    return { reply: "Memories cleared.", action: null };
  }

  const messages = [
    { role: "system", content: buildPrompt(facts, history) },
    { role: "user", content: userMessage }
  ];

  const tools = [
    { type: "function", function: {
      name: "web_search",
      description: "Multi-source search.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }},
    { type: "function", function: {
      name: "read_url",
      description: "Read a page.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
    }},
    { type: "function", function: {
      name: "research",
      description: "Deep research.",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] }
    }},
    { type: "function", function: {
      name: "phone_action",
      description: "Perform a phone action. Chain many calls in one response.",
      parameters: { type: "object", properties: {
        action_type: { type: "string", enum: [
          "OPEN_APP","SEARCH_WEB","WHATSAPP_MESSAGE","SEND_SMS",
          "TAP","VISION_TAP","TYPE","READ_SCREEN","READ_SCREEN_VISION",
          "GO_BACK","GO_HOME","SCROLL_DOWN","SCROLL_UP","WAIT"
        ]},
        query: { type: "string" }, to: { type: "string" },
        message: { type: "string" }, target: { type: "string" },
        text: { type: "string" }, ms: { type: "number" },
        say: { type: "string" }
      }, required: ["action_type","say"] }
    }},
    { type: "function", function: {
      name: "remember",
      description: "Save fact.",
      parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] }
    }},
    { type: "function", function: {
      name: "read_own_file",
      description: "Read Sky's code.",
      parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] }
    }},
    { type: "function", function: {
      name: "propose_code_change",
      description: "Propose code change.",
      parameters: { type: "object", properties: {
        file_path: { type: "string" }, summary: { type: "string" }, new_content: { type: "string" }
      }, required: ["file_path","summary","new_content"] }
    }}
  ];

  const allActions = [];
  let codeProposal = null;
  let iter = 0;
  let lastBrain = "unknown";

  const bigTask = isBigTask({ messages });
  const maxIter = bigTask ? MAX_ITER_BIG : MAX_ITER_SMALL;

  while (iter < maxIter) {
    iter++;
    const r = await callAI(env, {
      messages, tools, temperature: 0.5, max_tokens: 4000
    });

    if (!r.ok) {
      return {
        reply: String(r.error || "unknown").slice(0, 400),
        action: null, actions: allActions, brain: lastBrain
      };
    }

    lastBrain = r.brain || "unknown";
    const msg = r.message;
    const calls = msg.tool_calls || [];

    if (calls.length === 0) {
      const reply = (msg.content || "Okay.").trim();
      await saveHist(env, userId, history, userMessage, reply);
      return {
        reply, action: allActions[0] || null, actions: allActions,
        code_proposal: codeProposal, brain: lastBrain
      };
    }

    messages.push(msg);

    for (const call of calls) {
      const name = call.function.name;
      let a = {};
      try { a = JSON.parse(call.function.arguments || "{}"); } catch {}

      let result = {};

      if (name === "web_search") {
        result = await multiSearch(env, a.query || userMessage, 5);
      } else if (name === "read_url") {
        result = await fetchPageText(a.url);
      } else if (name === "research") {
        result = await deepResearch(env, a.topic || userMessage, 3);
      } else if (name === "phone_action") {
        const act = { type: a.action_type };
        if (a.query) act.query = a.query;
        if (a.to) act.to = a.to;
        if (a.message) act.message = a.message;
        if (a.target) act.target = a.target;
        if (a.text) act.text = a.text;
        if (typeof a.ms === "number") act.ms = a.ms;

        if (act.type === "OPEN_APP" && (!act.query || !act.query.trim())) {
          const lower = userMessage.toLowerCase();
          const known = ["whatsapp","chrome","telegram","youtube","camera",
                         "instagram","facebook","spotify","gmail","settings"];
          for (const k of known) if (lower.includes(k)) { act.query = k; break; }
        }

        allActions.push(act);
        result = { queued: true, action: act };
      } else if (name === "remember") {
        const f = String(a.fact || "").trim();
        if (f) {
          facts.push(f);
          if (facts.length > MEMORY_LIMIT) facts = facts.slice(-MEMORY_LIMIT);
          if (env.SKY_MEMORY) await env.SKY_MEMORY.put(userId + ":facts", JSON.stringify(facts));
        }
        result = { saved: true };
      } else if (name === "read_own_file") {
        result = await readOwnFile(env, String(a.file_path || ""));
      } else if (name === "propose_code_change") {
        const content = String(a.new_content || "");
        const lineCount = content.split("\n").length;
        if (lineCount > 400) {
          result = { error: "File too large. Max 400 lines." };
        } else {
          codeProposal = {
            file_path: String(a.file_path || ""),
            summary: String(a.summary || "Code change"),
            new_content: content
          };
          result = { proposed: true };
        }
      }

      messages.push({
        role: "tool", tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 12000)
      });
    }
  }

  const note = codeProposal
    ? "Drafted the change. Tap APPROVE."
    : "Say \"continue\" and I'll finish.";
  await saveHist(env, userId, history, userMessage, note);
  return {
    reply: note, action: null, actions: allActions,
    code_proposal: codeProposal, brain: lastBrain, incomplete: true
  };
}

async function readOwnFile(env, filePath) {
  if (!env.GITHUB_TOKEN) return { error: "No token" };
  if (!filePath) return { error: "No path" };
  try {
    const url = "https://api.github.com/repos/" + REPO + "/contents/" + filePath;
    const res = await fetch(url, {
      headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "SkyAI" }
    });
    if (!res.ok) return { error: "Not found" };
    const data = await res.json();
    const decoded = decodeURIComponent(escape(atob((data.content || "").replace(/\n/g, ""))));
    const lines = decoded.split("\n");
    const head = lines.slice(0, 60).join("\n");
    const tail = lines.length > 120 ? lines.slice(-30).join("\n") : lines.slice(60, 120).join("\n");
    return { content: "File: " + filePath + "\nLines: " + lines.length + "\n\n" + head + "\n...\n" + tail };
  } catch (e) {
    return { error: String(e) };
  }
}

async function saveHist(env, userId, history, u, r) {
  if (!env.SKY_MEMORY) return;
  try {
    history.push({ role: "user", content: u });
    history.push({ role: "assistant", content: r });
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    await env.SKY_MEMORY.put(userId + ":history", JSON.stringify(history));
  } catch {}
}

// ============================================
// MULTI-SOURCE SEARCH
// ============================================
async function multiSearch(env, query, maxResults) {
  const [ddg, bing, wiki, tav] = await Promise.all([
    ddgSearch(query, maxResults).catch(e => ({ results: [] })),
    bingSearch(query, maxResults).catch(e => ({ results: [] })),
    wikiSearch(query).catch(e => ({ results: [] })),
    tavily(env, query).catch(e => ({ results: [] }))
  ]);

  const all = [];
  const seen = new Set();
  function addAll(res, name) {
    for (const r of (res.results || [])) {
      const url = r.url || "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      all.push({ title: r.title || "", url, snippet: (r.snippet || "").slice(0, 400), source: name });
    }
  }
  addAll(ddg, "ddg");
  addAll(bing, "bing");
  addAll(wiki, "wiki");
  addAll(tav, "tavily");
  return { query, count: all.length, results: all.slice(0, maxResults) };
}

async function ddgSearch(query, numResults = 5) {
  const ua = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile";
  try {
    const formData = new URLSearchParams();
    formData.append("q", query);
    const response = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua },
      body: formData.toString()
    });
    if (response.ok) {
      const html = await response.text();
      const results = parseDDG(html, numResults);
      if (results.length > 0) return { results };
    }
  } catch (e) {}
  return { results: [] };
}

function parseDDG(html, numResults) {
  const results = [];
  try {
    const blocks = html.split(/<div class="result[^"]*"[^>]*>/);
    for (let i = 1; i < blocks.length && results.length < numResults; i++) {
      const block = blocks[i];
      const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/s);
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/s);
      if (linkMatch) {
        let url = linkMatch[1];
        const redirectMatch = url.match(/uddg=([^&]+)/);
        if (redirectMatch) { try { url = decodeURIComponent(redirectMatch[1]); } catch (e) {} }
        const title = stripTags(linkMatch[2]).trim();
        const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : "";
        if (url.startsWith("http") && title) results.push({ title, url, snippet });
      }
    }
  } catch (e) {}
  return results;
}

async function bingSearch(query, numResults = 5) {
  try {
    const response = await fetch(
      "https://www.bing.com/search?q=" + encodeURIComponent(query) + "&count=" + numResults,
      { headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile" } }
    );
    if (!response.ok) return { results: [] };
    const html = await response.text();
    const results = [];
    const blocks = html.split(/<li class="b_algo"/);
    for (let i = 1; i < blocks.length && results.length < numResults; i++) {
      const block = blocks[i];
      const linkMatch = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/s);
      const snippetMatch = block.match(/<p[^>]*>(.*?)<\/p>/s);
      if (linkMatch) {
        const url = linkMatch[1];
        const title = stripTags(linkMatch[2]).trim();
        const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : "";
        if (url.startsWith("http") && title) results.push({ title, url, snippet });
      }
    }
    return { results };
  } catch (e) {
    return { results: [] };
  }
}

async function wikiSearch(query) {
  try {
    const url = "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
      encodeURIComponent(query) + "&format=json&srlimit=3&srprop=snippet";
    const response = await fetch(url, { headers: { "User-Agent": "SkyAI/0.14" } });
    if (!response.ok) return { results: [] };
    const data = await response.json();
    const results = [];
    for (const item of (data.query?.search || [])) {
      results.push({
        title: item.title,
        url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(item.title.replace(/ /g, "_")),
        snippet: stripTags(item.snippet || "").trim()
      });
    }
    return { results };
  } catch (e) {
    return { results: [] };
  }
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"").replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

async function fetchPageText(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120" },
      redirect: "follow"
    });
    if (!response.ok) return { error: "HTTP " + response.status };
    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = titleMatch ? stripTags(titleMatch[1]) : "";
    let body = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ");
    let text = stripTags(body);
    return { url, title, text: text.slice(0, 6000) };
  } catch (e) {
    return { error: String(e) };
  }
}

async function deepResearch(env, query, maxPages = 3) {
  const search = await multiSearch(env, query, 6);
  if (!search.results || search.results.length === 0) return { error: "No results", pages: [] };
  const pages = [];
  for (let i = 0; i < Math.min(search.results.length, maxPages); i++) {
    const r = search.results[i];
    const page = await fetchPageText(r.url);
    if (!page.error && page.text) {
      pages.push({ url: r.url, title: page.title || r.title, text: page.text.slice(0, 1500) });
    }
  }
  return { query, search_results: search.results, pages, pages_read: pages.length };
}

async function tavily(env, query) {
  const keys = getKeys(env.TAVILY_API_KEYS, env.TAVILY_API_KEY);
  if (!keys.length) return { results: [] };
  const key = await pickKey(env, "tavily", keys);
  if (!key) return { results: [] };
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query, search_depth: "basic", include_answer: true, max_results: 5 })
    });
    if (!res.ok) {
      await markCooldown(env, "tavily", key);
      return { results: [] };
    }
    const d = await res.json();
    return {
      answer: d.answer || "",
      results: (d.results || []).slice(0, 5).map(r => ({
        title: r.title, url: r.url, snippet: (r.content || "").slice(0, 400)
      }))
    };
  } catch (e) {
    return { results: [] };
  }
}

// ============================================
// END OF FILE
// ============================================
