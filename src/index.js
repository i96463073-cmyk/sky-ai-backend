export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Sky AI backend is online 🚀", {
        headers: {
          "content-type": "text/plain; charset=UTF-8"
        }
      });
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "Sky AI",
        version: "0.1.0"
      });
    }

    return Response.json(
      {
        error: "Endpoint not found"
      },
      { status: 404 }
    );
  }
};
