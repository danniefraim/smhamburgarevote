import { Hono } from "hono";
import { adminRoutes } from "./admin-routes";
import { publicRoutes } from "./public-routes";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  console.error(JSON.stringify({ level: "error", message: err.message, stack: err.stack, path: c.req.path }));
  return c.json({ ok: false, code: "internal", message: "Internt fel — försök igen." }, 500);
});

app.route("/api/admin", adminRoutes);
app.route("/api", publicRoutes);
app.all("/api/*", (c) => c.json({ ok: false, code: "not_found" }, 404));

export default app;
