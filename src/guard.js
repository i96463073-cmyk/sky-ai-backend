// Fail-closed protection for the legacy /deploy route.
// The original agent code only checked a password when DEPLOY_SECRET existed,
// which left /deploy open if the secret was missing. This blocks that case.

export function deployGuard(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/deploy") return null;
  if (request.method === "OPTIONS") return null;
  if (env && env.DEPLOY_SECRET) return null;
  return new Response(
    JSON.stringify({ error: "Deployment is disabled: DEPLOY_SECRET is not configured" }),
    {
      status: 503,
      headers: { "Content-Type": "application/json; charset=UTF-8", "Access-Control-Allow-Origin": "*" }
    }
  );
}
