interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

type D1Database = object;

declare module "cloudflare:workers" {
  export const env: Record<string, unknown> & { DB?: D1Database };
}
