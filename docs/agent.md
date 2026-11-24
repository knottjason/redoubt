# Agent

Redoubt has one built-in conversation (the Agent page) and serves the same tools to any MCP client at `/mcp`.

## How it fits

- The tools are an MCP server inside Redoubt (`src/server/mcp.ts`). The built-in chat connects to it in memory; remote clients connect over streamable HTTP. Both get exactly the same tools.
- Tools only call the functions the pages use (`services` in `src/server/app.ts`), so an agent can do nothing a button can't, and Redoubt's policy (internal addresses are never blocked, the never-block list) applies to it too.
- Change tools: `decide_alert`, `set_rule`, `undo_decision`. In the built-in chat each one waits for the person: all changes from one reply appear on one card with a checkbox each. A remote client's own approval prompt is the gate there, so only give read-write tokens to clients that ask before running tools.
- Each change carries the agent's reason, which History shows. The rule's name on a decision is looked up by Redoubt from the sid (sensor rule set, else recent alerts), never taken from the model.
- `report_gap` lets any agent note a missing tool or confusing data on the Feedback page.
- Decisions made by the agent are recorded as `<person> (agent)`; by a remote client as `token:<name>`.

## Untrusted input

Alert payloads, DNS and TLS names, hostnames from DHCP and anything else seen on the wire can be written by whoever sent the traffic, and tools hand them to the model. Treat them as attacker-controlled text: a model can be talked into proposing something by what it reads. That is why every change goes through Redoubt's policy checks and, in the built-in chat, through the person's approval, and why read-write tokens belong only to clients that ask before running tools.

## Models

Set `AGENT_MODELS` and the matching keys (see `.env.example`). Built on the Vercel AI SDK: Anthropic, OpenAI, Google, xAI, and anything OpenAI-compatible (Ollama, llama.cpp, vLLM, LM Studio) as `local`. Give `@tokens` when a local model runs with a short context.

## Compaction

The full conversation is kept in `agent.sqlite` and always shown. When a reply used more than 75% of the model's context, the oldest 20–40% (cut at a question, never between a tool call and its result) is summarized into a running summary, and the model sees that summary plus the newer messages from then on.

## Remote MCP

Make a token on the Agent page (read only, or read and change), then point the client at `https://<redoubt>/mcp` with `Authorization: Bearer <token>`. Tokens are stored hashed and can be revoked. `/mcp` must bypass the reverse proxy's sign-in, since it signs in with the token instead.

## Read-only SQL

`query_sql` and `describe_tables` appear only when `CLICKHOUSE_AGENT_USER` is set. Make that login read-only on the ClickHouse side, which is what makes it safe:

```sql
CREATE SETTINGS PROFILE agent_ro SETTINGS readonly = 1, max_execution_time = 15, max_result_rows = 5000, result_overflow_mode = 'break', max_memory_usage = 2000000000;
CREATE USER agent IDENTIFIED BY '...' SETTINGS PROFILE agent_ro;
GRANT SELECT ON netmon.* TO agent;
```
