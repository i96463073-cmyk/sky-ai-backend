// Entry point. The original Sky AI phone-agent code lives unchanged in ./agent.js.
// New SKY AI SIGNALS routes live under /api/*.

import agent from "./agent.js";
import { handleApi } from "./api.js";
import { deployGuard } from "./guard.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);

    const blocked = deployGuard(request, env);
    if (blocked) return blocked;

    return agent.fetch(request, env, ctx);
  }
};
