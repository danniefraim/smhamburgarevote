import { SELF, env } from "cloudflare:test";
import { expect, it } from "vitest";

it("svarar på /api/health", async () => {
  const res = await SELF.fetch("http://test/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("migrationerna är applicerade med startvärden", async () => {
  const criteria = await env.DB.prepare("SELECT COUNT(*) AS n FROM criteria").first<{ n: number }>();
  expect(criteria?.n).toBe(4);
  const method = await env.DB.prepare("SELECT value FROM settings WHERE key='placement_method'").first<{ value: string }>();
  expect(method?.value).toBe("adjusted");
});
