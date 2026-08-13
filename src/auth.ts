import type { MiddlewareHandler } from "hono";

async function tokenMatches(token: string, expected: string): Promise<boolean> {
  if (!token || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(token)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function isAdminRequest(req: Request, env: Env): Promise<boolean> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return tokenMatches(token, env.ADMIN_TOKEN ?? "");
}

export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!(await isAdminRequest(c.req.raw, c.env))) {
    return c.json({ ok: false, code: "unauthorized", message: "Ogiltig eller saknad admin-nyckel." }, 401);
  }
  await next();
};
