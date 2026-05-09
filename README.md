# safebridge-mcp

A privacy-aware MCP server that lets Claude Code (or Cursor / Codex) call third-party LLMs (DeepSeek, etc.) for whole-repo context queries and non-critical code generation, while enforcing:

- **Allowlist-first file access** — the MCP only reads files matching configured globs.
- **Outbound redaction** — known-shape secrets (API keys, JWTs, phone numbers, emails, DB URIs) are scrubbed from prompts before they leave the machine.
- **Inbound scrubbing** — provider responses are also redacted in case they echo back a secret they were asked about.
- **Append-only audit log** — every outbound payload's SHA-256 is logged to a hash-chained file. You can prove later what was/wasn't sent.
- **Pre-flight token + cost preview** — refuses calls that exceed configured budget.

This is deliberately scoped *narrow*: it gives the calling LLM (e.g. me, Claude) a way to **delegate context-heavy or grunt work to a cheaper model** without you giving up control over what leaves your repo.

## Status

**Phase A** — safety primitives only. No network calls, no API keys required. You can run the test suite and read every line before we wire up any provider.

## Threat model

### What this protects against

- **Accidental leak of `.env`, credentials, key files**: hard denylist on filename patterns (`.env*`, `*credential*`, `*.key`, `secrets/**`, etc.). The MCP refuses to read these.
- **Accidental leak of known-shape secrets in source code**: regex redaction strips OpenAI/Anthropic/Google/Slack/GitHub keys, JWTs, DB connection URIs with creds, bearer tokens.
- **Accidental leak of customer PII**: phone numbers (US + international) and emails are redacted by default.
- **Path traversal**: the MCP resolves paths and refuses any path outside the configured project root.
- **Audit-log tampering**: each log entry includes SHA-256 of the previous entry. Modifying past entries breaks the chain.
- **Budget runaways**: per-call and per-day token/cost limits.

### What this does NOT protect against

- **PII in responses when `pseudonymize` is off (the default).** Responses only receive a secrets pass, not a PII pass. If DeepSeek echoes back a phone number or email that appeared in context files, it will arrive unredacted. safebridge warns you in the response footer when this applies (`⚠ N PII item(s) scrubbed from inputs but NOT from this response`). Use `pseudonymize: true` for end-to-end PII coverage.

- **Prompt injection from repo files.** If a source file contains text structured like a system instruction (`// SYSTEM: ignore previous instructions…`), it is forwarded to DeepSeek verbatim after redaction. safebridge cannot distinguish code comments from adversarial instructions. Keep your allowlist tight and only include files you trust.

- **The LLM provider itself logging or training on your prompts.** This is a policy/contract question, not a technical one. Read [DeepSeek's privacy policy](https://www.deepseek.com/privacy) before sending regulated data (HIPAA, GDPR, PCI).

- **Novel secret shapes** the regex doesn't recognize. A hardcoded value like `let creds = "abc123"` won't be caught unless `creds` matches one of the trigger words (`API_KEY`, `SECRET`, `PASSWORD`, `TOKEN`, etc.). Add custom patterns to `config.json` for your specific secret shapes.

- **The fact that source code is itself sensitive.** If your codebase contains proprietary algorithms, *any* outbound query leaks structure. Use `pseudonymize: true` or a self-hosted model for maximum privacy.

- **Concurrent budget enforcement.** `checkBudget` and `recordCost` are not atomic. Two concurrent calls could both pass the budget check before either records cost. In practice MCP clients call tools sequentially, making this theoretical — do not rely on the daily cap as a hard financial control.

- **A malicious orchestrator (the calling LLM).** This MCP trusts the calling LLM (Claude Code) to behave. Defense-in-depth: the allowlist + denylist still apply even if the orchestrator tries to read sensitive files.

### Trust boundary

```
[ Your repo ]
       │
       ▼
[ Calling LLM (Claude Code) ]──── trusted to drive, audited via hash log ────┐
       │                                                                     │
       ▼                                                                     │
[ safebridge-mcp ] ←── reads files ── ENFORCES allowlist, denylist, redaction│
       │                                                                     │
       ▼                                                                     │
[ DeepSeek API ] ←── HTTPS, your key ── prompts are SCRUBBED before this ────┘
```

## Architecture

```
tools/safebridge-mcp/
├── README.md            ← this file
├── package.json         ← deps: @modelcontextprotocol/sdk, zod
├── .env.example         ← keys + config template
├── .gitignore           ← excludes .env, audit log
├── config.json          ← user-editable allowlist/denylist/redaction patterns
└── src/
    ├── redact.js        ← regex-based scrubbing (outbound + inbound)
    ├── redact.test.js   ← adversarial unit tests
    ├── allowlist.js     ← file glob gating + path traversal protection
    ├── allowlist.test.js
    ├── audit.js         ← append-only hash-chained log
    ├── audit.test.js
    └── index.js         ← MCP server (Phase B)
```

## Roadmap

- ✅ **Phase A**: redaction, allowlist, audit log, threat model, tests. No network.
- ✅ **Phase B**: MCP server, `safebridge_query` and `safebridge_codegen` tools, budget tracker, end-to-end smoke test.
- ✅ **Phase C**: dry-run mode, reversible pseudonymization, `safebridge_audit` inspection tool.
- ✅ **Phase D**: `safebridge_discover` pre-flight tool, source-agnostic defaults, PII response warning, public release prep.
- ✅ **Phase E**: multi-provider support (OpenAI, Gemini, Ollama, DeepSeek default).
- ✅ **Phase F**: semantic retrieval (RAG) — vector index of the codebase, query by similarity.

## Setup

```bash
cd tools/safebridge-mcp
npm install
cp .env.example .env
# Edit .env: set SAFEBRIDGE_PROVIDER and the matching API key (see Providers below)
npm run check  # runs unit tests + smoke test
```

Then register the MCP in your Claude Code settings (`.claude/settings.json` or global `~/.claude/settings.json`):

```jsonc
{
  "mcpServers": {
    "safebridge": {
      "command": "node",
      "args": ["/absolute/path/to/safebridge-mcp/src/index.js"],
      "env": {
        "SAFEBRIDGE_PROJECT_ROOT": "/absolute/path/to/your/repo"
      }
    }
  }
}
```

`SAFEBRIDGE_PROJECT_ROOT` defaults to the working directory Claude Code launches the server from (usually your repo root), so you can omit it if that's already correct.

**Restart Claude Code** for it to pick up the new server.

## Providers

Set `SAFEBRIDGE_PROVIDER` in your `.env` (default: `deepseek`).

| Provider | Key env var | Default scan model | Default reason model |
|---|---|---|---|
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` | `deepseek-reasoner` |
| `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` | `gpt-4o` |
| `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` | `gemini-2.5-pro` |
| `ollama` | *(none)* | `llama3.3` | `llama3.3` |

**Ollama** runs locally — no API key, no cost, no data leaves your machine. Install Ollama and pull a model first:
```bash
ollama pull llama3.3
```
Then set `SAFEBRIDGE_PROVIDER=ollama` in `.env`. Override `OLLAMA_BASE_URL` if Ollama isn't on `localhost:11434`.

Override the default model per-call with the `model` parameter.

## Semantic Retrieval (RAG)

When your codebase is too large to fit in context, build a vector index and query by similarity instead of loading all files.

**Setup** (in `.env`):
```bash
SAFEBRIDGE_EMBED_PROVIDER=openai       # or ollama, gemini
OPENAI_API_KEY=sk-...                  # whichever key the embed provider needs
```

| Embed provider | Key env var | Default model | Dimensions |
|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | `text-embedding-3-small` | 1536 |
| `ollama` | *(none)* | `nomic-embed-text` | 768 |
| `gemini` | `GEMINI_API_KEY` | `text-embedding-004` | 768 |

**Build the index** (one-time, then update as files change):
```bash
# via safebridge_index tool in the chat:
safebridge_index action=build
# incremental after file changes:
safebridge_index action=update
```

**Query with retrieval:**
```jsonc
{ "prompt": "Where does the auth middleware validate JWTs?", "retrieval": true, "top_k": 20 }
```

**Security:** redaction runs at index-build time. Chunks stored in `.safebridge-index.json` contain already-redacted text. The query is also redacted before being sent to the embedding API.

## Tools exposed to the calling LLM

### `safebridge_query`
Ask your configured LLM a question about repo files. The MCP reads files matching the configured allowlist (optionally narrowed by `file_globs`), redacts known-shape secrets/PII, and returns the answer (also redacted).

```jsonc
{
  "prompt": "Where is org_id sourced from request bodies instead of auth context?",
  "file_globs": ["src/routes/**/*.ts"],   // optional
  "model": "gpt-4o-mini",                // optional, defaults to provider's scan model
  "max_tokens": 4096,                    // optional, default: 4096
  "pseudonymize": false,                 // optional - see below
  "dry_run": false,                      // optional - see below
  "retrieval": false,                    // optional - see below
  "top_k": 20                            // optional, only with retrieval:true
}
```

**`pseudonymize: true`** — Replaces PII (phones, emails, SSNs) with reversible placeholders (`PHONE_001`, `EMAIL_002`, ...) before sending. The response is unmapped back automatically so you see the real values. Use when you need the LLM to reason about specific identifiers (e.g. "trace this customer's flow") without exposing the values. Hard secrets (API keys, JWTs, DB URIs) are still lossy-redacted regardless.

**`dry_run: true`** — Prepare the payload but **do not** call the provider. Returns the redacted/pseudonymized prompt + token estimate + cost estimate. Use for sensitive prompts: dry-run first, eyeball the payload, then call again without `dry_run`. No API key required for dry-run.

**`retrieval: true`** — Instead of reading all matched files, embed the query and retrieve the `top_k` most relevant chunks from a pre-built vector index. Requires `SAFEBRIDGE_EMBED_PROVIDER` in `.env` and `safebridge_index build` to have been run. Best for targeted lookups on large allowlists that would exceed the token cap with full-file reads. Redaction is applied at index-build time; chunks are stored pre-redacted.

### `safebridge_codegen`
Same flow, tuned for code generation. Returns code blocks formatted as `### path/to/file` headers + fenced code. **The MCP never writes files** — the calling LLM (Claude) reviews and applies.

```jsonc
{
  "spec": "Add a Zod validator for the inbound webhook payload at src/routes/webhook.ts. Schema: ...",
  "file_globs": ["src/routes/webhook.ts", "src/types/payload.ts"],
  "model": "gpt-4o",   // optional, defaults to provider's reason model
  "dry_run": false
}
```

### `safebridge_index`
Build or manage the vector index for semantic retrieval.

```jsonc
{ "action": "build"  }               // full rebuild from the allowlist
{ "action": "update" }               // re-embed only changed files (incremental)
{ "action": "status" }               // staleness report (no embed calls)
{ "action": "clear"  }               // delete the index file
{ "action": "build", "file_globs": ["server/src/**/*.ts"] }  // index a subset
```

Requires `SAFEBRIDGE_EMBED_PROVIDER` in `.env` (and the matching API key). Once built, pass `retrieval: true` to `safebridge_query` to search by similarity instead of reading all files.

**Workflow:** discover → query (normal) or index build → query (retrieval)

### `safebridge_discover`
Preview which files would be included for a given glob set, with per-file token estimates. **No provider call, no API key required, no cost.** Use this before `safebridge_query` to find the right `file_globs` without guessing.

```jsonc
{ "file_globs": ["server/src/lib/**/*.ts"] }  // omit to see the full allowlist
{ "file_globs": ["src/**/*.ts"], "group_by": "ext" }  // group by extension
```

Returns a plain-text report:
```
safebridge discover - 47 files matched

Token estimate: 142,800 / 800,000 cap  [fits]

Files by directory:
  server/src/lib/core/  (12 files, ~48,200 tok)
    supervisor/engineMonitor.ts          3,840 tok

Suggestions - common narrowings:
  server/src/lib/core/**/*               (12 files, ~48,200 tok)
```

Workflow: **discover → query**, not query → hit token cap → discover.

### `safebridge_audit`
Inspect the audit log without leaving the chat.

```jsonc
{ "action": "tail",   "count": 20 }   // last N entries (default 20)
{ "action": "verify"                } // check hash chain integrity
{ "action": "stats"                 } // event counts, lifetime cost, total redactions
```

## Operations

| Command | What |
|---|---|
| `npm test` | Run unit tests for redact, allowlist, audit, budget |
| `npm run smoke` | Boot server, complete MCP handshake, list tools, verify no-key refusal |
| `npm run check` | `test` + `smoke` |
| `npm run verify-log [path]` | Verify hash chain integrity of an audit log |

## Audit log

Every tool call writes a line to `.safebridge-audit.log` (project root, gitignored). Each entry is hash-chained against the previous; tampering breaks the chain.

```jsonc
{"ts":"2026-05-05T22:31:14.123Z","seq":42,"event":"call_end","data":{...},"prev":"<sha256>","hash":"<sha256>"}
```

To audit later: `npm run verify-log`. Returns `{ok: true, count: N}` if intact.

## Budget

Daily spend tracked in `.safebridge-budget.json` (gitignored). Resets at UTC midnight. Calls refuse with `[safebridge refused] Daily budget cap reached.` once `SAFEBRIDGE_DAILY_BUDGET_USD` is hit. Pre-flight estimates are pessimistic (assume uncached input + full max_tokens output).

## Gitignore

Add these to your project's `.gitignore`:

```gitignore
# safebridge runtime files — not secrets, but not useful in git history
.safebridge-audit.log
.safebridge-budget.json
.safebridge-index.json
```

The `.env` file is already excluded by safebridge-mcp's own `.gitignore` inside the tool directory.

## License

MIT
