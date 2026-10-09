# free-opencode-proxy

OpenCode's **free** models exposed as standard **OpenAI** and **Anthropic** APIs.

Since ~2026-09-17 OpenCode's free tier rejects every client except the genuine
`opencode` binary (TLS-fingerprint gate — spoofing headers no longer works).
This proxy drives the real binary's local `opencode serve` API, so all upstream
calls are made by the genuine client and the free models keep working.

## Setup

```bash
npm install
npm start          # listens on :6447, auto-spawns `opencode serve`
```

API keys live in `api-keys.json` (auto-generated on first run if missing).

## Endpoints

| Method | Path | Format |
|--------|------|--------|
| `GET`  | `/v1/models` | OpenAI model list |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream supported) |
| `POST` | `/v1/messages` | Anthropic messages (stream supported) |
| `GET`  | `/health` | status |

Auth: `Authorization: Bearer <key>` (OpenAI) or `x-api-key: <key>` (Anthropic).
Base URL: `http://localhost:6447` (use `.../v1` for OpenAI clients).

```bash
# OpenAI format
curl http://localhost:6447/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}]}'

# Anthropic format
curl http://localhost:6447/v1/messages \
  -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

## Notes

- Multi-turn: send header `x-oc-session: <name>` (or OpenAI `user` field /
  Anthropic `metadata.user_id`) to pin a conversation. Without a key, each
  request is self-contained (full history replayed as a transcript) and the
  temporary opencode session is deleted as soon as the reply is in — the
  local opencode DB never accumulates junk sessions.
- The key pins a session **per key, not per conversation**: `user` /
  `metadata.user_id` are usually one app-wide ID, so every chat from the same
  frontend would collapse into a single opencode session. Pass a distinct
  `x-oc-session` value per conversation instead.
- Keyed sessions are held in memory only — restarting the proxy starts those
  conversations over. Stateless (key-less) requests are unaffected.
- Request sampling params (`temperature`, `max_tokens`) are not forwarded;
  opencode uses its own agent/model config.
- Streaming is **real**: `stream: true` forwards `message.part.delta` from
  opencode's `/event` SSE as tokens arrive, while the blocking prompt call is
  still running. Reasoning is emitted as `reasoning_content` (OpenAI) /
  `thinking` blocks (Anthropic) only when the model actually produces it; if
  no delta shows up it falls back to emitting the buffered reply in one burst.
- Client-supplied `tools` schemas are **not** forwarded — the opencode agent
  runs its own built-in tools (read/edit/bash) in `./oc-workspace` and folds
  results into the reply text.

## Environment

| Variable | Default | What |
|----------|---------|------|
| `PROXY_PORT` | `6447` | proxy port |
| `OC_BIN` | `~/.opencode/bin/opencode` | opencode binary path |
| `OC_WORKDIR` | `./oc-workspace` | agent working directory |
| `OC_SERVER` | — | reuse an existing `opencode serve` URL instead of spawning one |
| `OC_USERNAME` / `OC_PASSWORD` | `opencode` / — | basic auth for `OC_SERVER` |
| `OC_TIMEOUT` | `600` | per-request timeout (seconds) |
| `KEYS_FILE` | `./api-keys.json` | API keys file |
| `FREE_ONLY` | `1` | only serve models whose `cost` tiers are all zero (`0` = serve paid models too, you pay) |
| `ALLOWED_MODELS` | — | comma-separated explicit allowlist, e.g. `muse-spark-1.3-contributor-free,big-pickle` (overrides `FREE_ONLY`) |
