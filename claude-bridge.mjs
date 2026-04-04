#!/usr/bin/env node
/**
 * Claude Bridge — translates Anthropic Messages API → Claude Code CLI
 *
 * Lets any OpenAI/Anthropic-compatible client use Claude Max plan
 * (Sonnet / Opus / Haiku) via the locally authenticated `claude` CLI —
 * no API key required.
 *
 * Usage:
 *   node claude-bridge.mjs [--port 18801]
 *
 * Then point your client's Anthropic baseUrl to:
 *   http://127.0.0.1:18801
 *
 * Environment variables:
 *   CLAUDE_BIN   Path to the `claude` binary (default: auto-detected)
 *   PORT         Listening port (default: 18801, overridden by --port)
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? process.env.PORT ?? "18801", 10);

// Auto-detect claude binary: env var → which claude → common locations
function detectClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    return execSync("which claude", { encoding: "utf8" }).trim();
  } catch {}
  const candidates = [
    "/usr/local/bin/claude",
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    try { execSync(`test -x "${p}"`); return p; } catch {}
  }
  throw new Error("claude binary not found. Install Claude Code CLI or set CLAUDE_BIN.");
}

const CLAUDE_BIN = detectClaudeBin();

const MODEL_MAP = {
  "claude-opus-4-6": "opus",
  "claude-sonnet-4-6": "sonnet",
  "claude-haiku-4-5-20251001": "haiku",
  "claude-haiku-4-5": "haiku",
};

function resolveModel(model) {
  return MODEL_MAP[model] ?? model;
}

function extractAssistantText(event) {
  if (!event || event.type !== "assistant" || !event.message) return "";
  if (!Array.isArray(event.message.content)) return "";
  return event.message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** Turn Anthropic Messages API messages array into a single prompt string. */
function messagesToPrompt(messages, system) {
  const parts = [];
  if (system) {
    if (typeof system === "string") parts.push(`[System]\n${system}`);
    else if (Array.isArray(system))
      parts.push(`[System]\n${system.map((b) => b.text ?? "").join("\n")}`);
  }
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "Assistant" : "Human";
    let text;
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .map((b) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_use")
            return `[tool_use id=${b.id} name=${b.name}]\n${JSON.stringify(b.input)}`;
          if (b.type === "tool_result")
            return `[tool_result id=${b.tool_use_id}]\n${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}`;
          return JSON.stringify(b);
        })
        .join("\n");
    } else {
      text = JSON.stringify(msg.content);
    }
    parts.push(`[${role}]\n${text}`);
  }
  if (messages.length === 1 && messages[0].role === "user") {
    const c = messages[0].content;
    return typeof c === "string" ? c : parts.join("\n\n");
  }
  return parts.join("\n\n");
}

/** Call claude CLI with streaming JSON output. Yields partial events. */
function callClaudeStreaming(prompt, model, system, onEvent) {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--model", resolveModel(model),
      "--no-session-persistence",
      "--dangerously-skip-permissions",
      "--max-budget-usd", "10",
    ];
    if (system && typeof system === "string") {
      args.push("--append-system-prompt", system);
    }

    const child = spawn(CLAUDE_BIN, [...args, "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 900_000,
    });

    child.stdin.write(prompt);
    child.stdin.end();

    let buffer = "";
    let stderr = "";
    let finalResult = null;

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "result") finalResult = event;
          else onEvent(event);
        } catch {}
      }
    });

    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "result") finalResult = event;
          else onEvent(event);
        } catch {}
      }
      if (finalResult) return resolve(finalResult);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      reject(new Error("No result from claude CLI"));
    });
  });
}

/** Call claude CLI non-streaming. */
function callClaude(prompt, model, system) {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format", "json",
      "--model", resolveModel(model),
      "--no-session-persistence",
      "--dangerously-skip-permissions",
      "--max-budget-usd", "10",
    ];
    if (system && typeof system === "string") {
      args.push("--append-system-prompt", system);
    }

    const child = spawn(CLAUDE_BIN, [...args, "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 900_000,
    });

    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !stdout)
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`Failed to parse response: ${stdout.slice(0, 500)}`)); }
    });
  });
}

// --- SSE helpers ---

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleStreaming(res, params) {
  const model = params.model ?? "claude-sonnet-4-6";
  const prompt = messagesToPrompt(params.messages ?? [], params.system);
  const msgId = `msg_bridge_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  sseWrite(res, "message_start", {
    type: "message_start",
    message: {
      id: msgId, type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  sseWrite(res, "content_block_start", {
    type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" },
  });

  let fullText = "";
  let usage = {};

  try {
    const result = await callClaudeStreaming(
      prompt, model,
      typeof params.system === "string" ? params.system : null,
      (event) => {
        const delta = extractAssistantText(event);
        if (delta && delta.length > fullText.length) {
          const newText = delta.slice(fullText.length);
          fullText = delta;
          sseWrite(res, "content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: newText },
          });
        }
      }
    );

    const finalText = typeof result.result === "string" ? result.result : "";
    usage = result.usage ?? {};

    if (finalText.length > fullText.length) {
      sseWrite(res, "content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: finalText.slice(fullText.length) },
      });
    }

    sseWrite(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sseWrite(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: result.stop_reason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens ?? 0 },
    });
    sseWrite(res, "message_stop", { type: "message_stop" });
  } catch (err) {
    console.error(`[bridge] stream error: ${err.message}`);
    sseWrite(res, "error", {
      type: "error",
      error: { type: "api_error", message: err.message },
    });
  }

  res.end();
}

async function handleNonStreaming(res, params) {
  const model = params.model ?? "claude-sonnet-4-6";
  const prompt = messagesToPrompt(params.messages ?? [], params.system);

  try {
    const cliResult = await callClaude(
      prompt, model,
      typeof params.system === "string" ? params.system : null
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: `msg_bridge_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      type: "message", role: "assistant", model,
      content: [{ type: "text", text: cliResult.result ?? "" }],
      stop_reason: cliResult.stop_reason ?? "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: cliResult.usage?.input_tokens ?? 0,
        output_tokens: cliResult.usage?.output_tokens ?? 0,
        cache_creation_input_tokens: cliResult.usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: cliResult.usage?.cache_read_input_tokens ?? 0,
      },
    }));
  } catch (err) {
    console.error(`[bridge] error: ${err.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "api_error", message: err.message },
    }));
  }
}

// --- HTTP Server ---

const server = createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", bridge: "claude-code" }));
  }

  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      data: [
        { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
        { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
        { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
      ],
    }));
  }

  if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
    let body = "";
    for await (const chunk of req) body += chunk;

    let params;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "Invalid JSON body" },
      }));
    }

    const model = params.model ?? "claude-sonnet-4-6";
    const prompt = messagesToPrompt(params.messages ?? [], params.system);
    console.log(
      `[bridge] ${new Date().toISOString()} model=${model} stream=${!!params.stream} prompt_len=${prompt.length}`
    );

    return params.stream
      ? handleStreaming(res, params)
      : handleNonStreaming(res, params);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    type: "error",
    error: { type: "not_found_error", message: "Not Found" },
  }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[claude-bridge] listening on http://127.0.0.1:${PORT}`);
  console.log(`[claude-bridge] using claude binary: ${CLAUDE_BIN}`);
});
