// oc-api-proxy.mjs — OpenCode free models as OpenAI/Anthropic APIs.
//
// Why this exists: since ~2026-09-17 the OpenCode Zen free tier rejects every
// client except the genuine opencode binary (TLS-fingerprint gate). Header
// spoofing no longer works. This proxy drives the real binary's local
// `opencode serve` API, so upstream calls are made by the genuine client.
//
// Usage:
//   node oc-api-proxy.mjs                 # auto-spawns `opencode serve`
//   OC_SERVER=http://127.0.0.1:13284 \    # or use an already-running server
//   OC_PASSWORD=pass node oc-api-proxy.mjs
//
// Env:
//   PROXY_PORT   port for this proxy          (default 6447)
//   OC_BIN       path to opencode binary      (default ~/.opencode/bin/opencode)
//   OC_WORKDIR   working dir for the agent    (default ./oc-workspace)
//   OC_SERVER    reuse an existing opencode serve instance
//   OC_USERNAME  basic-auth user for OC_SERVER (default "opencode")
//   OC_PASSWORD  basic-auth password for OC_SERVER
//   OC_TIMEOUT   per-request timeout in sec   (default 600)
//
// Session behavior:
//   - Send header `x-oc-session: <name>` (or OpenAI `user` field, or
//     Anthropic metadata.user_id) to get a persistent multi-turn conversation.
//   - Without a key, every request is a fresh self-contained session whose
//     full message history is replayed as a transcript. That session is
//     deleted right after the reply so the opencode DB never fills up.
//
// Streaming: with stream=true we tap opencode's `GET /event` SSE and forward
//   `message.part.delta` as tokens while the blocking prompt call is still
//   running. If no delta ever shows up we fall back to the buffered reply.
//
// Limitation: client-supplied `tools` schemas are not forwarded; the opencode
// agent runs its own built-in tools (read/edit/bash) server-side and folds
// results into the reply text.

import express from "express";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { spawn } from "child_process";

// Base dir for api-keys.json / oc-workspace.
// Dev (node oc-api-proxy.mjs): the script's own directory.
// Packaged single-exe (SEA: argv has no script): the exe's directory,
// so keys + workspace travel with the exe (portable).
const HERE = (() => {
  const script = process.argv[1];
  if (!script || path.resolve(script) === path.resolve(process.execPath)) {
    return path.dirname(process.execPath);
  }
  return path.dirname(path.resolve(script));
})();
const PROXY_PORT = Number(process.env.PROXY_PORT || 6447);
const OC_SERVER = process.env.OC_SERVER;
const OC_USERNAME = process.env.OC_USERNAME || "opencode";
const OC_PASSWORD = process.env.OC_PASSWORD;
const OC_BIN = process.env.OC_BIN || findBinary();
const OC_WORKDIR = process.env.OC_WORKDIR || path.join(HERE, "oc-workspace");
const REQUEST_TIMEOUT = Number(process.env.OC_TIMEOUT || 600) * 1000;

function findBinary() {
  const candidates = [
    // Windows first: ~/.opencode/bin/opencode.exe
    path.join(os.homedir(), ".opencode", "bin", "opencode.exe"),
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    // Unix
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  // bare name: resolved via PATH (opencode / opencode.exe / opencode.cmd)
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

function ifExists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

// 解析 npm 的 .cmd 跳板, 挖出背后的真 .exe.
// 例: "%dp0%\node_modules\@opencode\cli\bin\opencode.exe" %*  →  C:\...\npm\node_modules\...exe
function unwrapCmdShim(cmdFile) {
  try {
    const text = fs.readFileSync(cmdFile, "utf8");
    const m = text.match(/"([^"]*opencode\.exe)"/i) || text.match(/([^\s"]*opencode\.exe)/i);
    if (!m) return null;
    let target = m[1];
    target = target.replace(/%dp0%\\?/gi, path.dirname(cmdFile) + path.sep);
    target = target.replace(/^"|"$/g, "");
    if (ifExists(target)) return target;
    // 有时 .cmd 指向的 exe 带版本号等, 做一次 basename 兜底
    const base = path.join(path.dirname(cmdFile), path.basename(target));
    if (ifExists(base)) return base;
    return null;
  } catch { return null; }
}

// ── API keys (same scheme as server.mjs) ────────────────────────────
const keysFile = process.env.KEYS_FILE || path.join(HERE, "api-keys.json");
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) if (tok === key) return name;
  return null;
}

// ── opencode serve backend ──────────────────────────────────────────
let ocBase = null;
let ocAuth = null;

function ocReq(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(ocBase + pathname);
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: {
          ...(ocAuth ? { Authorization: ocAuth } : {}),
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("opencode request timed out")); });
    if (data) req.write(data);
    req.end();
  });
}

async function startBackend() {
  if (OC_SERVER) {
    ocBase = OC_SERVER.replace(/\/$/, "");
    ocAuth = OC_PASSWORD
      ? "Basic " + Buffer.from(`${OC_USERNAME}:${OC_PASSWORD}`).toString("base64")
      : null;
    return;
  }
  let bin = OC_BIN;
  const isBareName = !bin.includes(path.sep) && !bin.includes("/");
  if (isBareName) {
    // bare command: resolve via PATH to an absolute path (no shell:true,
    // avoids DEP0190 + arg-concat injection). Windows prefers .exe.
    try {
      const { execSync } = await import("child_process");
      if (process.platform === "win32") {
        const out = execSync("where opencode", {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const lines = out
          .split(/\r?\n/)
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
        // 1) PATH 上的真 .exe 最优先
        bin = lines.find((l) => l.toLowerCase().endsWith(".exe") && ifExists(l)) || null;
        // 2) npm 的 opencode.cmd 只是跳板: @"%dp0%\node_modules\@opencode\cli\bin\opencode.exe" %*
        //    直接挖出背后的真 .exe, 避免走 cmd.exe.
        if (!bin) {
          for (const cmdFile of lines.filter((l) => /\.cmd$/i.test(l))) {
            const real = unwrapCmdShim(cmdFile);
            if (real) { bin = real; break; }
          }
        }
        // 3) 兜底: .cmd/.bat (稍后经 cmd.exe /c 单字符串启动)
        bin = bin ||
          lines.find((l) => /\.cmd$/i.test(l)) ||
          lines.find((l) => /\.bat$/i.test(l)) ||
          lines.find((l) => /\.[a-z0-9]+$/i.test(l)) ||
          null;
        if (!bin) {
          throw new Error(
            `where opencode only returned extensionless shims (${lines.join("; ")}) — set OC_BIN to the full opencode.cmd path`
          );
        }
      } else {
        if (!fs.existsSync("/usr/bin/opencode") && !fs.existsSync("/usr/local/bin/opencode")) {
          execSync("command -v opencode", { stdio: "ignore" });
        }
      }
    } catch {
      throw new Error("opencode binary not found — set OC_BIN or install opencode");
    }
  } else if (!fs.existsSync(bin)) {
    throw new Error(`opencode binary not found at ${bin} — set OC_BIN correctly`);
  }
  fs.mkdirSync(OC_WORKDIR, { recursive: true });
  const password = "oc-" + crypto.randomBytes(12).toString("hex");
  // .cmd/.bat shims can't be spawned directly — route via cmd.exe with
  // the whole command as ONE /c string (no shell:true, so no DEP0190).
  const isCmdShim = /\.cmd$|\.bat$/i.test(bin);
  const spawnFile = isCmdShim ? (process.env.ComSpec || "cmd.exe") : bin;
  const spawnArgs = isCmdShim
    ? ["/d", "/s", "/c", `""${bin}" serve --port 0 --hostname 127.0.0.1"`]
    : ["serve", "--port", "0", "--hostname", "127.0.0.1"];
  console.log(`[OC] spawning: ${spawnFile} ${spawnArgs.join(" ")} (cwd=${OC_WORKDIR})`);
  const child = spawn(spawnFile, spawnArgs, {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    cwd: OC_WORKDIR,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: isCmdShim ? true : undefined,
  });
  child.on("exit", (code) => console.log("[OC] opencode serve exited with code", code));
  process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });

  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      console.error("[OC] serve start timeout, captured output:\n" + buf.slice(-4000));
      reject(new Error("opencode serve did not start within 45s"));
    }, 45000);
    const onData = (d) => {
      buf += d.toString();
      if (buf.length > 20000) buf = buf.slice(-20000);
      const m = buf.match(/listening on https?:\/\/[^:]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn opencode (${bin} via ${spawnFile}): ${e.message}`));
    });
    child.on("exit", (c) => {
      clearTimeout(timer);
      console.error("[OC] serve early-exit output:\n" + (buf || "(no output)").slice(-4000));
      reject(new Error(`opencode serve exited early (code ${c}). Output tail above; try running manually: "${bin}" serve --port 0 --hostname 127.0.0.1`));
    });
  });
  ocBase = `http://127.0.0.1:${port}`;
  ocAuth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  console.log(`[OC] opencode serve backend on ${ocBase}`);

  // v2: plugins settle a few seconds after listen — /api/model is []
  // at first, then fills in. Poll until non-empty.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await ocReq("GET", "/api/model");
      if (r.status === 200 && Array.isArray(r.json?.data) && r.json.data.length > 0) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("opencode serve did not become healthy");
}

// ── models (v2: GET /api/model → { data: [{ id, modelID, providerID, cost }] }) ──
// FREE_ONLY=1 (default): only serve models whose cost tiers are all zero.
// ALLOWED_MODELS="a,b": explicit allowlist, overrides FREE_ONLY.
// FREE_ONLY=0: serve everything upstream offers (you pay).
const FREE_ONLY = !/^(0|false|no)$/i.test(process.env.FREE_ONLY ?? "1");
const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);

function isFreeModel(m) {
  const cost = m?.cost;
  return (
    Array.isArray(cost) &&
    cost.length > 0 &&
    cost.every((c) => Number(c?.input) === 0 && Number(c?.output) === 0)
  );
}

let modelCache = null;
let modelVariants = {}; // id -> [variantId]
let modelFree = {};     // id -> bool (all upstream opencode models)
function isBlockedPaid(modelId) {
  return modelId in modelFree && !modelFree[modelId] && !modelCache.includes(modelId);
}
async function getModels() {
  if (modelCache) return modelCache;
  // allow up to ~30s for plugin settlement on first call
  for (let i = 0; i < 60; i++) {
    const r = await ocReq("GET", "/api/model");
    if (r.status !== 200) throw new Error("failed to list opencode models");
    const data = Array.isArray(r.json?.data) ? r.json.data : [];
    const all = data.filter((m) => m?.providerID === "opencode");
    if (all.length) {
      modelFree = {};
      modelVariants = {};
      for (const m of all) {
        const id = m.id || m.modelID;
        if (!id) continue;
        modelFree[id] = isFreeModel(m);
        if (Array.isArray(m.variants)) {
          modelVariants[id] = m.variants.map((v) => v?.id).filter(Boolean);
        }
      }
      const ids = Object.keys(modelFree);
      modelCache = [
        ...new Set(
          ALLOWED_MODELS.length
            ? ids.filter((id) => ALLOWED_MODELS.includes(id))
            : FREE_ONLY
              ? ids.filter((id) => modelFree[id])
              : ids
        ),
      ];
      if (!modelCache.length) throw new Error("no models left after FREE_ONLY/ALLOWED_MODELS filtering");
      return modelCache;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no opencode models found");
}

// [xxx] 只是 CLI 的显示后缀(如 [1M] 指上下文, 并非 variant id).
// 只有出现在 /api/model variants 里的才往上游传, 否则用默认变体.
function effectiveVariant(modelId, v) {
  if (!v) return undefined;
  const allowed = modelVariants[modelId];
  if (allowed && !allowed.includes(v)) {
    console.log(`[OC] unknown variant "${v}" for ${modelId}, using default variant`);
    return undefined;
  }
  return v;
}

// ── translation: chat formats → opencode prompt ─────────────────────
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c.type === "text") return c.text ?? "";
        if (c.type === "tool_result")
          return typeof c.content === "string"
            ? c.content
            : Array.isArray(c.content)
              ? c.content.map((x) => x.text || "").join("\n")
              : "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function messagesToPrompt(messages) {
  let system = "";
  const turns = [];
  for (const m of messages || []) {
    if (m.role === "system") system += (system ? "\n\n" : "") + extractText(m.content);
    else turns.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${extractText(m.content)}`);
  }
  const lastUserText = [...turns].reverse().find((t) => t.startsWith("User:"))?.slice(6) ?? "";
  return { system, transcript: turns.join("\n\n"), lastUserText };
}

function anthropicToPrompt(body) {
  const system = typeof body.system === "string" ? body.system : extractText(body.system);
  const { transcript, lastUserText } = messagesToPrompt(body.messages);
  return { system, transcript, lastUserText };
}

// ── sessions ────────────────────────────────────────────────────────
const sessions = new Map(); // key -> { sessionID, turns, chain }
function sessionEntry(key) {
  if (!sessions.has(key)) sessions.set(key, { sessionID: null, turns: 0, chain: Promise.resolve() });
  return sessions.get(key);
}

// opencode CLI 的模型写法: [variant] 后缀表示变体(如 xxx[1M]),
// [opencode/] 前缀是跨客户端兼容写法. v2 Model.Ref = { id, providerID, variant? }
function parseModel(raw) {
  let s = String(raw || "").replace(/^opencode\//, "");
  let variant;
  const m = s.match(/^(.+?)\[(.+?)\]$/);
  if (m) { s = m[1]; variant = m[2]; }
  return { id: s, variant };
}

function modelRef(modelId, modelVariant) {
  return {
    id: modelId,
    providerID: "opencode",
    ...(modelVariant ? { variant: modelVariant } : {}),
  };
}

function upstreamError(r) {
  const msg =
    r.json?.data?.message ||
    r.json?.error?.message ||
    r.json?.message ||
    (typeof r.raw === "string" && r.raw.slice(0, 300)) ||
    `opencode server returned ${r.status}`;
  const err = new Error(msg);
  err.status = [400, 401, 402, 429].includes(r.status) ? r.status : 502;
  return err;
}

function assistantError(aErr) {
  const msg =
    aErr?.message ||
    aErr?.data?.message ||
    (typeof aErr === "string" ? aErr : "opencode run failed");
  const status = aErr?.status;
  const err = new Error(msg);
  // provider.quota (402 Insufficient funds) / rate limits pass through,
  // everything else becomes a 502 upstream error
  err.status = [400, 401, 402, 429].includes(status) ? status : 502;
  return err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureModel(sid, modelId, modelVariant) {
  const r = await ocReq("POST", `/api/session/${sid}/model`, {
    model: modelRef(modelId, effectiveVariant(modelId, modelVariant)),
  });
  if (r.status !== 200 && r.status !== 204) throw upstreamError(r);
}

// v2 prompt is async: POST /prompt enqueues, the agent runs in background.
// Poll message list until the assistant turn completes (or execution fails
// via SSE — watch.error — or a failed assistant message).
async function promptAndWait(sid, text, watch) {
  // Snapshot pre-existing messages first: on a pinned (stateful) session an
  // early poll can otherwise see the PREVIOUS turn's completed assistant and
  // return it as this turn's reply (same answer repeated every turn).
  const known = new Set();
  try {
    const before = await ocReq("GET", `/api/session/${sid}/message?order=asc&limit=100`);
    for (const d of (before.json?.data || [])) if (d?.id) known.add(d.id);
  } catch {}
  const posted = await ocReq("POST", `/api/session/${sid}/prompt`, { text });
  if (posted.status !== 200) throw upstreamError(posted);
  const deadline = Date.now() + REQUEST_TIMEOUT;
  while (Date.now() < deadline) {
    if (watch?.error) throw watch.error;
    const m = await ocReq("GET", `/api/session/${sid}/message?order=asc&limit=100`);
    if (m.status !== 200) throw upstreamError(m);
    const datas = Array.isArray(m.json?.data) ? m.json.data : [];
    const assistants = datas.filter((d) => d?.type === "assistant" && d?.id && !known.has(d.id));
    const lastA = assistants[assistants.length - 1];
    if (lastA) {
      if (lastA.error) throw assistantError(lastA.error);
      if (lastA.finish === "error") {
        throw assistantError({ message: "assistant run failed (finish=error)", status: 502 });
      }
      if (lastA.time?.completed) return { status: 200, json: lastA };
    }
    if (watch?.done) {
      // execution finished but no completed assistant — surface what we have
      if (lastA) return { status: 200, json: lastA };
      throw new Error("opencode run finished without an assistant message");
    }
    await sleep(1500);
  }
  throw new Error("opencode request timed out");
}

function buildText({ system, transcript, lastUserText }) {
  const body = transcript || lastUserText;
  // v2 prompt has no `system` field — fold it into the text
  return system ? `[System instructions]\n${system}\n\n${body}` : body;
}

// Preset the session title so the server skips its async title generation
// (agent=title, small=true), which would otherwise bill one extra call on
// Zen's rotating small model (gpt-6-luna, gpt-5.4-nano, ...) per session.
function buildTitle(lastUserText) {
  const t = String(lastUserText || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return t || "proxy session";
}

async function deleteSession(sid) {
  try {
    await ocReq("DELETE", `/api/session/${sid}`);
  } catch (e) {
    console.log(`[OC] temp session ${sid} not deleted:`, e.message);
  }
}

async function ask({ key, system, modelId, modelVariant, transcript, lastUserText, onSession, watch }) {
  const text = buildText({ system, transcript, lastUserText });
  if (!text) throw Object.assign(new Error("No user message in request"), { status: 400 });
  const variant = effectiveVariant(modelId, modelVariant);
  const modelKey = modelId + (variant ? `[${variant}]` : "");
  if (!key) {
    // stateless: fresh session per request, deleted right after the reply.
    const created = await ocReq("POST", "/api/session", {
      model: modelRef(modelId, variant),
      title: buildTitle(lastUserText),
    });
    if (created.status !== 200) throw upstreamError(created);
    const sid = created.json?.data?.id;
    if (!sid) throw new Error("opencode did not return a session id");
    onSession?.(sid);
    try {
      return await promptAndWait(sid, text, watch);
    } finally {
      deleteSession(sid);
    }
  }
  // stateful: pin one opencode session per key; first turn replays the
  // transcript, later turns send only the newest user message
  const entry = sessionEntry(key);
  const run = entry.chain.then(async () => {
    if (!entry.sessionID) {
      const created = await ocReq("POST", "/api/session", {
        model: modelRef(modelId, variant),
        title: buildTitle(lastUserText),
      });
      if (created.status !== 200) throw upstreamError(created);
      entry.sessionID = created.json?.data?.id;
      if (!entry.sessionID) throw new Error("opencode did not return a session id");
      entry.turns = 0;
      entry.modelKey = modelKey;
    }
    if (entry.modelKey !== modelKey) {
      try {
        await ensureModel(entry.sessionID, modelId, variant);
        entry.modelKey = modelKey;
      } catch {
        // model switch failed (e.g. session went stale) — recreate
        await deleteSession(entry.sessionID);
        const created = await ocReq("POST", "/api/session", {
          model: modelRef(modelId, variant),
          title: buildTitle(lastUserText),
        });
        if (created.status !== 200) throw upstreamError(created);
        entry.sessionID = created.json?.data?.id;
        entry.turns = 0;
        entry.modelKey = modelKey;
      }
    }
    onSession?.(entry.sessionID);
    const turnText = entry.turns === 0 ? text : (system ? `[System instructions]\n${system}\n\n${lastUserText}` : lastUserText);
    entry.turns++;
    return promptAndWait(entry.sessionID, turnText, watch);
  });
  entry.chain = run.catch(() => {});
  return run;
}

// ── translation: opencode message → chat formats ────────────────────
// v1 shape: { parts: [{type,text}], info: {tokens, finish} }
// v2 shape: { content: [{type:'text'|'reasoning',text}], tokens, finish, error }
function extractMessage(message) {
  let text = "";
  let reasoning = "";
  const parts = message?.parts || message?.content || [];
  for (const p of parts) {
    if (p.type === "text") text += p.text ?? "";
    else if (p.type === "reasoning") reasoning += p.text ?? "";
  }
  const tokens = message?.info?.tokens || message?.tokens || {};
  return {
    text,
    reasoning,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    finish: message?.info?.finish ?? message?.finish,
  };
}

function mapFinish(finish) {
  return finish === "length" ? "length" : "stop";
}

const rid = (prefix) => prefix + crypto.randomBytes(12).toString("hex");

function openaiResponse(modelId, r) {
  return {
    id: rid("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: r.text,
          ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
        },
        finish_reason: mapFinish(r.finish),
      },
    ],
    usage: {
      prompt_tokens: r.inputTokens,
      completion_tokens: r.outputTokens,
      total_tokens: r.inputTokens + r.outputTokens,
    },
  };
}

function writeSafe(res, s) {
  if (res.writableEnded || res.destroyed) return false;
  try { return res.write(s); } catch { return false; }
}

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function openaiSink(res, modelId) {
  const id = rid("chatcmpl-");
  const created = Math.floor(Date.now() / 1000);
  let opened = false;
  let sentText = "";
  let sentReasoning = "";
  const chunk = (delta, finish, usage) =>
    `data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  const open = () => {
    if (opened) return true;
    if (res.writableEnded || res.destroyed) return false;
    opened = true;
    sseHead(res);
    writeSafe(res, chunk({ role: "assistant" }));
    return true;
  };
  const rest = (full, sent) => (!sent ? full || "" : full && full.startsWith(sent) ? full.slice(sent.length) : "");
  return {
    get opened() { return opened; },
    delta(kind, text) {
      if (!open()) return;
      if (kind === "reasoning") { sentReasoning += text; writeSafe(res, chunk({ reasoning_content: text })); }
      else { sentText += text; writeSafe(res, chunk({ content: text })); }
    },
    finish(r) {
      if (!open()) return;
      const reasoning = rest(r.reasoning, sentReasoning);
      const text = rest(r.text, sentText);
      if (reasoning) writeSafe(res, chunk({ reasoning_content: reasoning }));
      if (text) writeSafe(res, chunk({ content: text }));
      writeSafe(res, chunk({}, mapFinish(r.finish), {
        prompt_tokens: r.inputTokens,
        completion_tokens: r.outputTokens,
        total_tokens: r.inputTokens + r.outputTokens,
      }));
      writeSafe(res, "data: [DONE]\n\n");
      try { res.end(); } catch {}
    },
    fail(message) {
      if (!open()) return;
      writeSafe(res, `data: ${JSON.stringify({ error: { message } })}\n\n`);
      writeSafe(res, "data: [DONE]\n\n");
      try { res.end(); } catch {}
    },
  };
}

function anthropicResponse(modelId, r) {
  return {
    id: rid("msg_"),
    type: "message",
    role: "assistant",
    model: modelId,
    content: [{ type: "text", text: r.text }],
    stop_reason: r.finish === "length" ? "max_tokens" : "end_turn",
    usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
  };
}

function anthropicSink(res, modelId) {
  const id = rid("msg_");
  let opened = false;
  let block = null;
  let index = -1;
  let sentText = "";
  let sentReasoning = "";
  const send = (event, data) => writeSafe(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const openBlock = (type) => {
    if (block === type) return;
    if (block) send("content_block_stop", { type: "content_block_stop", index });
    index += 1;
    block = type;
    send("content_block_start", {
      type: "content_block_start",
      index,
      content_block: type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
    });
  };
  const open = () => {
    if (opened) return true;
    if (res.writableEnded || res.destroyed) return false;
    opened = true;
    sseHead(res);
    send("message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", content: [], model: modelId,
        stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    return true;
  };
  const rest = (full, sent) => (!sent ? full || "" : full && full.startsWith(sent) ? full.slice(sent.length) : "");
  const emit = (type, text) => {
    openBlock(type);
    send("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: type === "thinking" ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text },
    });
  };
  return {
    get opened() { return opened; },
    delta(kind, text) {
      if (!open()) return;
      if (kind === "reasoning") { sentReasoning += text; emit("thinking", text); }
      else { sentText += text; emit("text", text); }
    },
    finish(r) {
      if (!open()) return;
      const reasoning = rest(r.reasoning, sentReasoning);
      const text = rest(r.text, sentText);
      if (reasoning) { sentReasoning += reasoning; emit("thinking", reasoning); }
      if (text) { sentText += text; emit("text", text); }
      if (block) send("content_block_stop", { type: "content_block_stop", index });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: r.finish === "length" ? "max_tokens" : "end_turn" },
        usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
      });
      send("message_stop", { type: "message_stop" });
      try { res.end(); } catch {}
    },
    fail(message) {
      if (!open()) return;
      send("error", { type: "error", error: { type: "api_error", message } });
      try { res.end(); } catch {}
    },
  };
}

// ── live deltas: opencode's SSE /event ─────────────────────────────
// ── live deltas: opencode's SSE /api/event ─────────────────────────
// v1:  { type: "message.part.delta", properties: { sessionID, partID, delta } }
// v2:  data: {"id","type":"session.*","data":{"sessionID", ...}}
// v2 prompt is async, so promptAndWait polls for completion; the SSE tap
// only forwards best-effort streaming deltas and watches for
// session.execution.failed to fail fast with the real provider error.
// If no delta ever shows up the sink falls back to the buffered reply.
function eventSessionID(ev, p) {
  return p.sessionID || ev.sessionID || ev.data?.sessionID || null;
}
function findDeltaText(obj, depth = 0) {
  if (!obj || depth > 4) return null;
  if (typeof obj === "string") return null;
  if (typeof obj.delta === "string" && obj.delta) return obj.delta;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const hit = findDeltaText(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
function connectEvents(watch) {
  let req = null;
  let done = false;
  let buf = "";
  const close = () => {
    if (done) return;
    done = true;
    try { req?.destroy(); } catch {}
  };
  const onFrame = (frame) => {
    if (!frame || frame.startsWith(":") || !frame.includes("data:")) return;
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    let ev;
    try { ev = JSON.parse(line.slice(5)); } catch { return; }
    const p = ev.properties || ev.data || {};
    if (watch.sid && eventSessionID(ev, p) && eventSessionID(ev, p) !== watch.sid) return;
    const type = ev.type || "";
    // completion / failure signals (v2 + v1)
    if (type === "session.execution.completed" || type === "session.execution.idle") {
      watch.done = true;
      return;
    }
    if (type === "session.execution.failed" || type === "session.step.failed") {
      const errPayload = p.error || ev.error || p.data?.error;
      watch.error = assistantError(errPayload || { message: "opencode run failed", status: 502 });
      watch.done = true;
      return;
    }
    // v1 part tracking
    if (type === "message.part.updated" && p.part && p.part.id) {
      watch.types.set(p.part.id, p.part.type);
      return;
    }
    if ((type === "message.part.delta" || type.endsWith("part.delta")) && typeof p.delta === "string" && p.delta) {
      const kind = watch.types.get(p.partID) === "reasoning" ? "reasoning" : "text";
      watch.sink?.delta(kind, p.delta);
      return;
    }
    // v2 generic: any event carrying a delta string for our session
    if (/delta|part|message/i.test(type)) {
      const delta = findDeltaText(p) || findDeltaText(ev);
      if (delta) {
        const kind = /reason|think/i.test(JSON.stringify(p).slice(0, 500)) ? "reasoning" : "text";
        watch.sink?.delta(kind, delta);
      }
      // track part types when present
      const part = p.part || ev.part;
      if (part?.id) watch.types.set(part.id, part.type);
    }
  };
  try {
    const u = new URL(ocBase + "/api/event");
    req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "GET",
        headers: { ...(ocAuth ? { Authorization: ocAuth } : {}), Accept: "text/event-stream" },
        timeout: REQUEST_TIMEOUT,
      },
      (r) => {
        r.setEncoding("utf8");
        r.on("data", (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            try { onFrame(frame); } catch {}
          }
        });
        r.on("end", close);
        r.on("error", close);
      }
    );
    req.on("error", close);
    req.on("timeout", close);
    req.end();
  } catch {
    close();
  }
  return { close };
}

// ── HTTP API ────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/v1/models", async (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: { message: "Invalid API key" } });
  try {
    const models = await getModels();
    res.json({
      object: "list",
      data: models.map((id) => ({ id, object: "model", created: 1779000000, owned_by: "opencode" })),
    });
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: "upstream_error" } });
  }
});

app.post("/v1/chat/completions", async (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: { message: "Invalid API key" } });
  let sink = null;
  let watch = null;
  try {
    const { model, messages, stream, user: userId } = req.body || {};
    const { id: modelId, variant: modelVariant } = parseModel(model);
    const models = await getModels();
    if (!models.includes(modelId)) {
      if (isBlockedPaid(modelId)) {
        return res.status(403).json({
          error: { message: `Model ${modelId} is a paid model — blocked (FREE_ONLY=1). Free models: ${models.join(", ")}`, type: "invalid_request_error" },
        });
      }
      return res.status(400).json({
        error: { message: `Unknown model: ${modelId}. Available: ${models.join(", ")}` },
      });
    }
    const { system, transcript, lastUserText } = messagesToPrompt(messages);
    if (!lastUserText) return res.status(400).json({ error: { message: "No user message in request" } });
    const key = req.headers["x-oc-session"] || userId || null;
    console.log(`[REQ] ${new Date().toISOString()} chat key=${auth(req)} model=${modelId}${modelVariant ? `[${modelVariant}]` : ""} stream=${!!stream} session=${key || "(stateless)"}`);
    if (stream) {
      sink = openaiSink(res, modelId);
      watch = { sid: null, types: new Map(), sink, conn: null };
      watch.conn = connectEvents(watch);
      res.on("close", () => watch.conn.close());
    }
    const r = await ask({
      key, system, modelId, modelVariant, transcript, lastUserText, watch,
      onSession: (sid) => { if (watch) watch.sid = sid; },
    });
    if (r.status !== 200) throw upstreamError(r);
    const extracted = extractMessage(r.json);
    if (!extracted.text && !extracted.reasoning && !(sink && sink.opened)) {
      throw new Error("empty response from opencode");
    }
    if (stream) return sink.finish(extracted);
    return res.json(openaiResponse(modelId, extracted));
  } catch (e) {
    console.error(`[ERR] ${new Date().toISOString()} chat model=${modelId} session=${key || "(stateless)"} status=${e.status || 502}: ${e.message}`);
    if (sink && sink.opened) return sink.fail(e.message);
    return res.status(e.status || 502).json({ error: { message: e.message, type: "upstream_error" } });
  } finally {
    watch?.conn?.close();
  }
});

app.post("/v1/messages", async (req, res) => {
  if (!auth(req)) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  let sink = null;
  let watch = null;
  try {
    const { model, stream, metadata } = req.body || {};
    const { id: modelId, variant: modelVariant } = parseModel(model);
    const models = await getModels();
    if (!models.includes(modelId)) {
      if (isBlockedPaid(modelId)) {
        return res.status(403).json({
          type: "error",
          error: { type: "permission_error", message: `Model ${modelId} is a paid model — blocked (FREE_ONLY=1). Free models: ${models.join(", ")}` },
        });
      }
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: `Unknown model: ${modelId}. Available: ${models.join(", ")}` },
      });
    }
    const { system, transcript, lastUserText } = anthropicToPrompt(req.body);
    if (!lastUserText) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "No user message in request" },
      });
    }
    const key = req.headers["x-oc-session"] || metadata?.user_id || null;
    console.log(`[REQ] ${new Date().toISOString()} messages key=${auth(req)} model=${modelId}${modelVariant ? `[${modelVariant}]` : ""} stream=${!!stream} session=${key || "(stateless)"}`);
    if (stream) {
      sink = anthropicSink(res, modelId);
      watch = { sid: null, types: new Map(), sink, conn: null };
      watch.conn = connectEvents(watch);
      res.on("close", () => watch.conn.close());
    }
    const r = await ask({
      key, system, modelId, modelVariant, transcript, lastUserText, watch,
      onSession: (sid) => { if (watch) watch.sid = sid; },
    });
    if (r.status !== 200) throw upstreamError(r);
    const extracted = extractMessage(r.json);
    if (!extracted.text && !extracted.reasoning && !(sink && sink.opened)) {
      throw new Error("empty response from opencode");
    }
    if (stream) return sink.finish(extracted);
    return res.json(anthropicResponse(modelId, extracted));
  } catch (e) {
    console.error(`[ERR] ${new Date().toISOString()} messages model=${modelId} session=${key || "(stateless)"} status=${e.status || 502}: ${e.message}`);
    if (sink && sink.opened) return sink.fail(e.message);
    return res.status(e.status || 502).json({
      type: "error",
      error: { type: e.status === 429 ? "rate_limit_error" : "upstream_error", message: e.message },
    });
  } finally {
    watch?.conn?.close();
  }
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", opencode: ocBase, models: modelCache ? modelCache.length : 0 })
);

// ── start ───────────────────────────────────────────────────────────
app.listen(PROXY_PORT, "0.0.0.0", async () => {
  console.log(`oc-api-proxy on http://0.0.0.0:${PROXY_PORT}`);
  console.log("  OpenAI:    POST /v1/chat/completions");
  console.log("  Anthropic: POST /v1/messages");
  console.log("  Models:    GET  /v1/models");
  try {
    await startBackend();
    const models = await getModels();
    console.log(`  Models (${FREE_ONLY && !ALLOWED_MODELS.length ? "free only" : ALLOWED_MODELS.length ? "allowlist" : "all"}):`, models.join(", "));
  } catch (e) {
    console.error("  Failed to start opencode backend:", e.message);
    process.exit(1);
  }
  for (const [name, key] of Object.entries(apiKeys)) console.log(`  ${name.padEnd(15)} ${key}`);
});
