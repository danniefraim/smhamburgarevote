// Hemligheter finns inte i wrangler.jsonc och genereras därför inte av `wrangler types`.
declare namespace Cloudflare {
  interface Env {
    ADMIN_TOKEN: string;
  }
}
