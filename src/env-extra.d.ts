// Hemligheter finns inte i wrangler.jsonc och genereras därför inte av `wrangler types`.
// Global interface-merge på både Env (workern) och Cloudflare.Env (cloudflare:test).
interface Env {
  ADMIN_TOKEN: string;
}

declare namespace Cloudflare {
  interface Env {
    ADMIN_TOKEN: string;
  }
}
