# claude-bridge

A lightweight local HTTP server that translates the **Anthropic Messages API** into calls to the **Claude Code CLI** — letting you use your Claude Max plan (Sonnet, Opus, Haiku) from any compatible client without needing a separate API key.

## How it works

```
Your app  →  POST /v1/messages  →  claude-bridge  →  claude CLI  →  Claude Max
```

The bridge speaks the Anthropic HTTP API on one side and shells out to the `claude` binary on the other. Streaming (SSE) and non-streaming are both supported.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` in your PATH)
- Node.js 18+
- A Claude Max subscription (the plan that gives you high-usage access)

## Usage

```bash
# Start on default port 18801
node claude-bridge.mjs

# Custom port
node claude-bridge.mjs --port 9000

# Custom claude binary path
CLAUDE_BIN=/path/to/claude node claude-bridge.mjs
```

Then point your client's Anthropic `baseUrl` to:
```
http://127.0.0.1:18801
```

No API key is required — the bridge uses the CLI's existing auth.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/v1/models` | List available models |
| POST | `/v1/messages` | Send a message (streaming + non-streaming) |

## Supported models

| Model ID | Resolves to |
|----------|-------------|
| `claude-opus-4-6` | `opus` |
| `claude-sonnet-4-6` | `sonnet` |
| `claude-haiku-4-5` | `haiku` |

## Run as a background service (macOS launchd)

Create `~/Library/LaunchAgents/com.claude-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/claude-bridge.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/claude-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/claude-bridge.err.log</string>
</dict>
</plist>
```

Then: `launchctl load ~/Library/LaunchAgents/com.claude-bridge.plist`

## License

MIT
