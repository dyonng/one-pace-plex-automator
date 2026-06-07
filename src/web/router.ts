import http from "http";

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  json: (status: number, body: unknown) => void;
  body: <T = Record<string, unknown>>() => Promise<T | null>;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

function segments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/** Match route segments against request segments; returns captured params or null. */
function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(actual[i]);
    else if (p !== actual[i]) return null;
  }
  return params;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy(); // oversized-body guard
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Tiny exact-match router with :param segments. Exact matching means route order
 * is irrelevant — no "/settings/reset before /settings" footguns.
 */
export class Router {
  private routes: { method: string; segs: string[]; handler: Handler }[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, segs: segments(pattern), handler });
    return this;
  }
  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }

  /** Dispatch a request. Returns true if a route handled it, false otherwise. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const method = req.method ?? "GET";
    const [rawPath, rawQuery = ""] = (req.url ?? "/").split("?");
    const actual = segments(rawPath);

    for (const r of this.routes) {
      if (r.method !== method) continue;
      const params = matchSegments(r.segs, actual);
      if (!params) continue;

      const ctx: Ctx = {
        req,
        res,
        params,
        query: new URLSearchParams(rawQuery),
        json: (status, body) => {
          res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(body));
        },
        body: <T>() => readJsonBody(req) as Promise<T | null>,
      };
      await r.handler(ctx);
      return true;
    }
    return false;
  }
}
