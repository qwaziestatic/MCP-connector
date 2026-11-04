import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleRequest, NOTION_TOKEN_URL, NOTION_VERSION } from "./notion-sign-in.ts";

const env = { NOTION_CLIENT_ID: "client-id", NOTION_CLIENT_SECRET: "client-secret" };
const origin = "https://sign-in.example.workers.dev";
const state = "app-state-0123456789abcdef";

function get(path: string): Request {
  return new Request(`${origin}${path}`);
}

function post(path: string, body: unknown): Request {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

/** A fake Notion token endpoint that records what it was sent. */
function fakeNotion(status = 200, answer: unknown = {
  access_token: "ntn_token",
  token_type: "bearer",
  refresh_token: "nrt_refresh",
  bot_id: "bot",
  workspace_id: "workspace",
  workspace_name: "Dagim's workspace"
}) {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(answer), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("Notion sign-in service", () => {
  it("sends the browser to Notion with this service as the return address", async () => {
    const response = await handleRequest(get(`/notion/start?port=53682&state=${state}`), env);

    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, "https://api.notion.com/v1/oauth/authorize");
    assert.deepEqual(Object.fromEntries(location.searchParams), {
      client_id: "client-id",
      response_type: "code",
      owner: "user",
      redirect_uri: `${origin}/notion/callback`,
      state: `53682.${state}`
    });
  });

  it("refuses a bad start link", async () => {
    for (const path of [
      "/notion/start",
      `/notion/start?port=80&state=${state}`,
      `/notion/start?port=99999&state=${state}`,
      "/notion/start?port=53682&state=short",
      "/notion/start?port=53682&state=bad%20state%20with%20spaces"
    ]) {
      const response = await handleRequest(get(path), env);
      assert.equal(response.status, 400, path);
      assert.equal(response.headers.get("location"), null, path);
    }
  });

  it("returns the code to the app on this computer only", async () => {
    const response = await handleRequest(get(`/notion/callback?code=abc&state=53682.${state}`), env);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `http://127.0.0.1:53682/oauth/callback?state=${state}&code=abc`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  });

  it("passes a declined sign-in back to the app", async () => {
    const response = await handleRequest(get(`/notion/callback?error=access_denied&state=53682.${state}`), env);
    assert.equal(response.headers.get("location"), `http://127.0.0.1:53682/oauth/callback?state=${state}&error=access_denied`);
  });

  it("does not redirect a callback the app did not start", async () => {
    for (const path of [
      "/notion/callback?code=abc",
      `/notion/callback?code=abc&state=${state}`,
      `/notion/callback?code=abc&state=evil.com.${state}`,
      `/notion/callback?code=abc&state=53682.${state}%2F..%2F`
    ]) {
      const response = await handleRequest(get(path), env);
      assert.equal(response.status, 400, path);
      assert.equal(response.headers.get("location"), null, path);
    }
  });

  it("exchanges a code with the client secret and passes Notion's answer through", async () => {
    const { fetchImpl, calls } = fakeNotion();
    const response = await handleRequest(post("/notion/token", { code: "abc" }), env, fetchImpl);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.access_token, "ntn_token");
    assert.equal(body.refresh_token, "nrt_refresh");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, NOTION_TOKEN_URL);
    assert.equal(calls[0]?.headers.get("authorization"), `Basic ${btoa("client-id:client-secret")}`);
    assert.equal(calls[0]?.headers.get("notion-version"), NOTION_VERSION);
    assert.equal(calls[0]?.headers.get("content-type"), "application/json");
    assert.deepEqual(calls[0]?.body, { grant_type: "authorization_code", code: "abc", redirect_uri: `${origin}/notion/callback` });
  });

  it("refreshes tokens", async () => {
    const { fetchImpl, calls } = fakeNotion();
    const response = await handleRequest(post("/notion/refresh", { refresh_token: "nrt_old" }), env, fetchImpl);

    assert.equal(response.status, 200);
    assert.deepEqual(calls[0]?.body, { grant_type: "refresh_token", refresh_token: "nrt_old" });
  });

  it("passes Notion's errors through with their status", async () => {
    const { fetchImpl } = fakeNotion(400, { object: "error", status: 400, code: "invalid_grant", message: "Invalid code." });
    const response = await handleRequest(post("/notion/token", { code: "used" }), env, fetchImpl);

    assert.equal(response.status, 400);
    assert.equal((await response.json() as Record<string, unknown>).code, "invalid_grant");
  });

  it("refuses a bad token request without calling Notion", async () => {
    for (const [path, body] of [
      ["/notion/token", "not json"],
      ["/notion/token", { code: 42 }],
      ["/notion/token", { code: "x".repeat(600) }],
      ["/notion/token", { code: "x".repeat(5000) }],
      ["/notion/refresh", {}]
    ] as const) {
      const { fetchImpl, calls } = fakeNotion();
      const response = await handleRequest(post(path, body), env, fetchImpl);
      assert.equal(response.status, 400, path);
      assert.equal(calls.length, 0, path);
    }
  });

  it("says when Notion cannot be reached", async () => {
    const fetchImpl = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const response = await handleRequest(post("/notion/token", { code: "abc" }), env, fetchImpl);

    assert.equal(response.status, 502);
    assert.equal((await response.json() as Record<string, unknown>).error, "notion_unreachable");
  });

  it("reports missing settings on its home page and refuses to sign in without them", async () => {
    const home = await handleRequest(get("/"), { NOTION_CLIENT_ID: "client-id" });
    assert.equal(home.status, 500);
    assert.match(await home.text(), /missing NOTION_CLIENT_SECRET/);
    assert.equal((await handleRequest(get("/"), env)).status, 200);

    const { fetchImpl, calls } = fakeNotion();
    const token = await handleRequest(post("/notion/token", { code: "abc" }), {}, fetchImpl);
    assert.equal(token.status, 500);
    assert.equal(calls.length, 0);
  });

  it("answers 404 for anything else", async () => {
    assert.equal((await handleRequest(get("/notion/token"), env)).status, 404);
    assert.equal((await handleRequest(post("/notion/start", {}), env)).status, 404);
    assert.equal((await handleRequest(get("/favicon.ico"), env)).status, 404);
  });
});
