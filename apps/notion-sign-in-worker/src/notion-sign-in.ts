// Notion sign-in for MCP Connector. Notion's token endpoint needs the
// integration's client secret, which cannot be kept inside an installer, so
// this service holds it and does the two token calls for the app:
//
//   GET  /notion/start?port=P&state=S  sends the browser to Notion's consent page
//   GET  /notion/callback              Notion returns here; sends the browser
//                                      back to the app on http://127.0.0.1:P
//   POST /notion/token   {code}           exchanges the code for tokens
//   POST /notion/refresh {refresh_token}  renews the tokens
//
// It stores nothing and logs nothing: tokens pass through in the response.
// https://developers.notion.com/docs/authorization

export interface Env {
  readonly NOTION_CLIENT_ID?: string;
  readonly NOTION_CLIENT_SECRET?: string;
}

export const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
export const NOTION_VERSION = "2026-03-11";

/** The app's own random state; the port it listens on is added in front. */
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_BODY_BYTES = 4096;

const commonHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...commonHeaders, "content-type": "application/json; charset=utf-8" }
  });
}

function error(status: number, code: string, description: string): Response {
  return json(status, { error: code, error_description: description });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function page(status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>MCP Connector</title><p>${escapeHtml(message)}</p>`,
    { status, headers: { ...commonHeaders, "content-type": "text/html; charset=utf-8" } }
  );
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { ...commonHeaders, location } });
}

function parsePort(text: string | null | undefined): number | null {
  if (text === null || text === undefined || !/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1024 && port <= 65_535 ? port : null;
}

function start(url: URL, clientId: string, callbackUrl: string): Response {
  const port = parsePort(url.searchParams.get("port"));
  const state = url.searchParams.get("state") ?? "";
  if (port === null || !STATE_PATTERN.test(state)) {
    return page(400, "This sign-in link is not valid. Go back to MCP Connector and click Connect again.");
  }
  const authorize = new URL(NOTION_AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    owner: "user",
    redirect_uri: callbackUrl,
    state: `${port}.${state}`
  }).toString();
  return redirect(authorize.href);
}

function callback(url: URL): Response {
  const match = /^(\d{1,5})\.([A-Za-z0-9_-]{16,128})$/.exec(url.searchParams.get("state") ?? "");
  const port = parsePort(match?.[1]);
  if (match === null || port === null || match[2] === undefined) {
    return page(400, "This sign-in did not start in MCP Connector. Go back to the app and click Connect again.");
  }
  // Only ever back to the app on this computer.
  const back = new URL(`http://127.0.0.1:${port}/oauth/callback`);
  back.searchParams.set("state", match[2]);
  const code = url.searchParams.get("code");
  const failure = url.searchParams.get("error");
  if (failure !== null) {
    back.searchParams.set("error", failure.slice(0, 100));
  } else if (code !== null && code.length > 0 && code.length <= 512) {
    back.searchParams.set("code", code);
  } else {
    back.searchParams.set("error", "invalid_request");
  }
  return redirect(back.href);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringField(body: Record<string, unknown> | null, name: string, maxLength: number): string | null {
  const value = body?.[name];
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

async function callNotion(
  clientId: string,
  clientSecret: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(NOTION_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "content-type": "application/json",
        "notion-version": NOTION_VERSION
      },
      body: JSON.stringify(body)
    });
  } catch {
    return error(502, "notion_unreachable", "The sign-in service could not reach Notion. Try again.");
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return error(502, "bad_gateway", `Notion returned an unexpected response (${response.status}).`);
  }
  // Notion's own answer, tokens or error, passed through unchanged.
  return json(response.status, parsed);
}

export async function handleRequest(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const clientId = env.NOTION_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.NOTION_CLIENT_SECRET?.trim() ?? "";
  const missing = [clientId === "" ? "NOTION_CLIENT_ID" : null, clientSecret === "" ? "NOTION_CLIENT_SECRET" : null]
    .filter((name): name is string => name !== null);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /") {
    return missing.length === 0
      ? page(200, "MCP Connector's Notion sign-in service is running.")
      : page(500, `MCP Connector's Notion sign-in service is missing ${missing.join(" and ")}. Set ${missing.length === 1 ? "it" : "them"} with "npx wrangler secret put".`);
  }
  if (!["GET /notion/start", "GET /notion/callback", "POST /notion/token", "POST /notion/refresh"].includes(route)) {
    return error(404, "not_found", "Not found.");
  }
  if (missing.length > 0) {
    return route.startsWith("GET")
      ? page(500, "Notion sign-in is not set up on this service yet. Tell the person who runs it.")
      : error(500, "server_error", `The sign-in service is missing ${missing.join(" and ")}.`);
  }

  // Must match a redirect URI registered on the Notion integration.
  const callbackUrl = `${url.origin}/notion/callback`;
  switch (route) {
    case "GET /notion/start":
      return start(url, clientId, callbackUrl);
    case "GET /notion/callback":
      return callback(url);
    case "POST /notion/token": {
      const code = stringField(await readJson(request), "code", 512);
      if (code === null) return error(400, "invalid_request", "Send {\"code\": \"...\"} as JSON.");
      return callNotion(clientId, clientSecret, { grant_type: "authorization_code", code, redirect_uri: callbackUrl }, fetchImpl);
    }
    default: {
      const refreshToken = stringField(await readJson(request), "refresh_token", 1024);
      if (refreshToken === null) return error(400, "invalid_request", "Send {\"refresh_token\": \"...\"} as JSON.");
      return callNotion(clientId, clientSecret, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
    }
  }
}
