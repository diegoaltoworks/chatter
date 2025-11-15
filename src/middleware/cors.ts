import type { Context, Next } from "hono";

export const cors = () => async (c: Context, next: Next) => {
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-headers", "content-type, x-api-key, authorization");
  c.header("access-control-allow-methods", "POST, GET, OPTIONS");
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, x-api-key, authorization",
        "access-control-allow-methods": "POST, GET, OPTIONS",
      },
    });
  }
  await next();
};
