import { loadTelegramConfig } from "./core/telegram-config.js";
import { routeRoot, mintBootstrapToken, bootstrapExpired } from "./core/bridge.js";
import { renderBridgeResponse } from "./core/bridge-page.js";
import { verifyToken, TOKEN_KIND, MalformedTokenError } from "./core/token.js";
import { doSeedFromBootstrapNonce, doNameFromSeed } from "./core/do-routing.js";
import { FrameDecoder, FRAME, encodeWelcome } from "./core/protocol-v3.js";

const CREATE_BODY_MAX_BYTES = 64;

function localNotFound() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

function bearerOf(request) {
  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
  return match ? match[1] : null;
}

async function tryVerify(token, kind, signingKey) {
  try {
    return await verifyToken(token, kind, signingKey);
  } catch (err) {
    if (err instanceof MalformedTokenError) return null;
    throw err;
  }
}

function sessionStub(env, doName) {
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(doName));
}

function mapDoError(json) {
  if (json.errorType === "NotFoundError") return localNotFound();
  if (json.errorType === "BodyMismatchError") return new Response(null, { status: 409, headers: { "Cache-Control": "no-store" } });
  return new Response(null, { status: 500 });
}

async function isSingleHello(bytes) {
  try {
    const decoder = new FrameDecoder("relay-inbound");
    decoder.push(bytes);
    const frames = [...decoder.drain()];
    return frames.length === 1 && frames[0].type === FRAME.HELLO;
  } catch {
    return false;
  }
}

async function handleCreate(request, env, cfg) {
  const token = bearerOf(request);
  if (!token) return null;
  const verified = await tryVerify(token, TOKEN_KIND.BOOTSTRAP, cfg.signingKey);
  if (!verified) return null;
  if (bootstrapExpired(verified.nonce)) return localNotFound();
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > CREATE_BODY_MAX_BYTES) return new Response(null, { status: 413, headers: { "Cache-Control": "no-store" } });
  if (!(await isSingleHello(body))) return localNotFound();
  const seed = await doSeedFromBootstrapNonce(verified.nonce);
  const stub = sessionStub(env, doNameFromSeed(seed));
  const reply = await stub.fetch(new Request("https://session-do/create", { method: "POST", body }));
  const json = await reply.json();
  if (!json.ok) return mapDoError(json);
  return new Response(encodeWelcome(), {
    status: 200,
    headers: {
      "X-Session-Token": json.result,
      "X-Down-Cursor": "0",
      "X-Carrier-Mode": "websocket",
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store"
    }
  });
}

async function handleDelete(request, env, cfg) {
  const token = bearerOf(request);
  if (!token) return null;
  const verified = await tryVerify(token, TOKEN_KIND.SESSION, cfg.signingKey);
  if (!verified) return null;
  const stub = sessionStub(env, doNameFromSeed(verified.nonce));
  const reply = await stub.fetch(new Request("https://session-do/delete", { method: "DELETE" }));
  const json = await reply.json();
  if (!json.ok) return mapDoError(json);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

async function handleWebSocket(request, env, cfg) {
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return null;
  const first = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",")[0].trim();
  const match = /^tproxy-v1\.([A-Za-z0-9_-]{43})$/.exec(first);
  if (!match) return null;
  const verified = await tryVerify(match[1], TOKEN_KIND.SESSION, cfg.signingKey);
  if (!verified) return null;
  return sessionStub(env, doNameFromSeed(verified.nonce)).fetch(request);
}

async function handleTelegram(request, env, cfg) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.searchParams.has("bridge")) {
    const route = await routeRoot(request, cfg);
    if (route === "bridge") return renderBridgeResponse(cfg.hostname, await mintBootstrapToken(cfg.signingKey));
    if (route === "local404") return localNotFound();
    return null;
  }
  if (url.pathname === "/api/v1/session") {
    if (request.method === "POST") return handleCreate(request, env, cfg);
    if (request.method === "DELETE") return handleDelete(request, env, cfg);
    return null;
  }
  if (url.pathname === "/api/v1/ws") return handleWebSocket(request, env, cfg);
  return null;
}

async function handleTelegramWithEnv(request, env) {
  const cfg = await loadTelegramConfig(env);
  if (!cfg) return null;
  return handleTelegram(request, env, cfg);
}

export { handleTelegram, handleTelegramWithEnv };
