# MCP Toggl

> Talk to your time tracking. Pull reports, start timers, inspect desktop activity, and turn raw Toggl data into useful recaps from Claude or any MCP-compatible client.

[![npm](https://img.shields.io/npm/v/@yakirmar/mcp-toggl)](https://www.npmjs.com/package/@yakirmar/mcp-toggl)
[![MCP](https://img.shields.io/badge/MCP-server-blueviolet)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Toggl API](https://img.shields.io/badge/Toggl-API%20v9-red)](https://developers.track.toggl.com/docs/)

> **This is a fork** of [`@verygoodplugins/mcp-toggl`](https://github.com/verygoodplugins/mcp-toggl), published as `@yakirmar/mcp-toggl`. It makes the server **read-write**: upstream could only read data and start/stop timers, so you couldn't log past work, fix a bad entry, or manage projects and clients. See [Fork Additions](#fork-additions).

## Fork Additions

Upstream is essentially read-only: it reads entries, reports, and lists, and can start/stop a timer. It cannot log work you already did, remove a mistake, or create the project you want to track against. This fork adds **9 tools** that close those loops.

### Time entries

| Tool | Why it exists |
| --- | --- |
| `toggl_create_entry` | Log work you already did — a completed entry on a project or client, with a start time plus either an end time or a length in minutes. Upstream could only start a *running* timer. |
| `toggl_search_entries` | Find entries (and, crucially, their `id`) by description, project name, client name, tag, time window, or duration. The `id` is what you need to delete something. |
| `toggl_delete_entry` | Remove an entry by `id`. Pair with `toggl_search_entries` when you don't already know it. |

### Projects and clients (full CRUD)

Upstream could only *list* projects and clients. This fork adds create, update, and delete for both, so an assistant can set up and maintain your Toggl structure rather than just read it.

| Tool | Why it exists |
| --- | --- |
| `toggl_create_project` | Create a project, optionally attached to a client, with billing, color, dates, and rate. |
| `toggl_update_project` | Rename, recolor, re-bill, move to another client, or **archive** (`active: false`) a project. |
| `toggl_delete_project` | Permanently remove a project. |
| `toggl_create_client` | Create a client. |
| `toggl_update_client` | Rename, annotate, or **archive** (`archived: true`) a client. |
| `toggl_delete_client` | Permanently remove a client. |

### Team and admin visibility

Upstream can only ever see **your own** time, because every entry read goes through Toggl's `/me/time_entries` — an endpoint that is self-scoped by definition, no matter how much admin power your token has. To see what your *team* did, you have to go through Toggl's separate **Reports API**. This fork does that.

| Tool | Why it exists |
| --- | --- |
| `toggl_list_users` | Who is in a **workspace** — id, name, email, admin/owner flags. |
| `toggl_list_org_users` | Who is in the **organization**, across every workspace — plus active status, role, org/workspace admin flags, and how many workspaces each member belongs to. |
| `toggl_team_entries` | What everyone worked on. Cross-user entries filterable by `user_ids`, `project_ids`, `client_ids`, `tag_ids`, `billable`, description, and duration. |
| `toggl_team_summary` | Hours per user for a period — total, billable, and how many projects each person touched. |

> **These three require workspace admin rights.** Access is enforced by Toggl, not by this server: a non-admin token simply sees only its own data (or gets a 403). **They also expose teammates' entry descriptions** — treat the output as sensitive.

Together these let you say things like *"log 2 hours on the Website project for yesterday's client call"*, *"find the duplicate standup entry from last week and delete it"*, *"create a Retainer project for Globex, billable at 150/hr"*, or *"who on the team logged the most billable hours last month?"*.

**Timezone handling:** datetimes accept an explicit offset (`2026-07-11T09:00:00Z`, `...+03:00`) for an absolute time. Without an offset — including a bare `YYYY-MM-DD` — the time is interpreted in **the timezone of the machine running the server**.

**Archive vs delete:** deleting a project or client is irreversible and orphans the association on existing records (time entries lose their project; projects lose their client). Prefer archiving — `toggl_update_project` with `active: false`, or `toggl_update_client` with `archived: true` — when you want to keep history.

**Cache coherence:** every project/client mutation invalidates the cached lists for that workspace, so a subsequent `toggl_list_projects` / `toggl_list_clients` reflects the change immediately instead of serving a stale list until the TTL expires.

## See What Your Week Actually Looked Like

> You ask: "Give me the recap of my week"

The MCP server returns hydrated time entries with project, workspace, client, tag, and running-timer context. Your client can turn that into a readable recap:

> 32.7 hours across 31 entries and 7 projects. Monday was a light planning day, Tuesday had the long implementation block, Wednesday stayed focused on one project, and Friday turned into a shipping run. The top project took 27% of the week, with two smaller projects close behind.

![Weekly recap chart](docs/images/weekly-recap.svg)

The server does not hard-code this prose or chart. It exposes structured Toggl data in a shape that makes synthesis easy.

## Catch the Drift

> You ask: "Did I actually work on what I said I worked on for that PR review entry?"

`toggl_get_timeline` can compare a tracked entry boundary with Toggl Track Desktop activity:

> The entry ran 1h 33m. About 67 minutes were in review tools, 5 minutes were scattered across chat apps, and the rest was idle or trimmed timeline space. The entry mostly checks out.

![Drift detection chart](docs/images/drift-detection.svg)

This is useful before invoicing, after long context-switching days, or whenever a vague entry like "admin" starts hiding too much Slack and browser time.

## See Patterns Over Time

> You ask: "Show me last month at a glance"

Daily and weekly report tools make it straightforward for the client to render heatmaps, spot streaks, and surface intensity changes:

![Monthly heatmap](docs/images/monthly-heatmap.svg)

Toggl is still the source of truth. The MCP layer makes the data easier for an agent to inspect, summarize, and visualize.

## Things You Can Ask

```text
What am I currently tracking?
How much time did I spend on the website project this month?
Start a timer for "PR review" on the Platform project
Log 2 hours yesterday on the Website project for "client call"
Find the entries I logged for "standup" last week
Delete the duplicate entry I created this morning
Create a billable "Retainer" project for the Globex client at 150/hr
Archive the old Website project
Rename the client "Acme" to "Acme Corp"
Who is in my workspace?
Who logged the most billable hours last month?
What did Jane work on this week?
Show me yesterday's hours as a chart
What apps did I use most today?
Generate a daily report for last Friday
Compare this week to last week by project
Which day this month had the most billable work?
```

Chart prompts depend on your MCP client. The server returns the structured data; clients such as Claude decide how to render it.

## What Makes This Useful

**Hydrated responses**: time entries are enriched with `project_name`, `client_name`, `workspace_name`, `tag_names`, and normalized running-timer fields so the client does not need a second lookup for ordinary reporting.

**Smart caching**: workspaces, projects, clients, tasks, and tags are cached after first read. `toggl_cache_stats` shows hits, misses, loaded entities, and hit rate.

**Desktop activity timeline**: `toggl_get_timeline` summarizes app usage from Toggl Track Desktop and can return raw events when you need sequence analysis.

**Privacy controls**: timeline calls support summary-only output with `include_events: false` and title redaction with `redact_titles: true`.

**Period shortcuts**: `today`, `yesterday`, `week`, `lastWeek`, `month`, and `lastMonth` are supported on the tools where those periods make sense.

**Recoverable errors**: workspace resolution errors include `available_workspaces`, and Toggl quota/rate-limit errors include structured retry hints.

## Quick Start

### Prerequisites

- Node.js `^20.19.0` or `>=22.12.0`
- A Toggl Track account
- Your Toggl API token from [track.toggl.com/profile](https://track.toggl.com/profile)

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-toggl": {
      "command": "npx",
      "args": ["-y", "@yakirmar/mcp-toggl@latest"],
      "env": {
        "TOGGL_API_KEY": "your_api_key_here",
        "TOGGL_DEFAULT_WORKSPACE_ID": "123456"
      }
    }
  }
}
```

`TOGGL_DEFAULT_WORKSPACE_ID` is optional. If you have exactly one Toggl workspace, the server can resolve it automatically. If you have multiple workspaces and do not set a default, workspace-scoped tools return the available workspace IDs so the client can retry with `workspace_id`.

Restart Claude Desktop, then ask:

```text
What am I currently tracking?
```

### Global Install

```bash
npm install -g @yakirmar/mcp-toggl
mcp-toggl --help
```

### Hosted HTTP Server

`dist/http-server.js` serves the same tools over Streamable HTTP at `/mcp`, for hosting on a platform like Heroku (the repo's `Procfile` runs it). The server holds no Toggl token: each user brings their own, and every session runs in a separate process with that token. Users authenticate either with OAuth (Claude.ai connectors, Claude Code) or with headers (`mcp-remote`, scripts).

#### As a Claude connector (OAuth)

The server is its own small OAuth provider, so it can be added as a custom connector in Claude.ai, Claude Desktop, and mobile — no headers to configure:

1. In Claude, go to **Customize > Connectors > Add custom connector** (Team/Enterprise owners: **Organization settings > Connectors**) and enter `https://your-app.herokuapp.com/mcp`.
2. Click **Connect**. A sign-in page from the server asks for the **access code** (the server's `MCP_HTTP_API_KEY`, which the owner shares with the people allowed to use it), the user's own **Toggl API token**, and an optional **default workspace ID**.
3. The server checks the token against Toggl and hands Claude an OAuth token that encodes that grant. Each user acts as their own Toggl account.

Claude Code: `claude mcp add --transport http toggl https://your-app.herokuapp.com/mcp` and run `/mcp` to sign in.

Access tokens last one hour and refresh automatically; a sign-in lasts 30 days, after which Claude asks the user to sign in again. Tokens are sealed with a key derived from `MCP_HTTP_API_KEY`, so rotating that value signs everyone out at once — that is also how you revoke access.

#### With headers

For clients that can't do OAuth, send these headers instead:

| Header | Purpose |
| --- | --- |
| `X-API-Key` | Shared secret that gates access to the server (`MCP_HTTP_API_KEY`). |
| `X-Toggl-Api-Key` | The caller's own Toggl API token (their `TOGGL_API_KEY`). A session is bound to the token that opened it. |
| `X-Toggl-Default-Workspace-Id` | Optional. The caller's `TOGGL_DEFAULT_WORKSPACE_ID`. |

Claude Code:

```bash
claude mcp add --transport http toggl https://your-app.herokuapp.com/mcp \
  --header "X-API-Key: <server key>" \
  --header "X-Toggl-Api-Key: <your Toggl token>" \
  --header "X-Toggl-Default-Workspace-Id: 123456"
```

Claude Desktop (via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), which fills `${VAR}` in headers from `env`):

```json
{
  "mcpServers": {
    "mcp-toggl": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://your-app.herokuapp.com/mcp",
        "--header", "X-API-Key:${MCP_HTTP_API_KEY}",
        "--header", "X-Toggl-Api-Key:${TOGGL_API_KEY}",
        "--header", "X-Toggl-Default-Workspace-Id:${TOGGL_DEFAULT_WORKSPACE_ID}"
      ],
      "env": {
        "MCP_HTTP_API_KEY": "server key",
        "TOGGL_API_KEY": "your_api_key_here",
        "TOGGL_DEFAULT_WORKSPACE_ID": "123456"
      }
    }
  }
}
```

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `MCP_HTTP_API_KEY` | Yes | - | Long random secret (e.g. `openssl rand -hex 32`). Doubles as the OAuth access code and the token-sealing key. The server refuses to start without it. |
| `MCP_HTTP_PUBLIC_URL` | Recommended | derived from `Host` | The `https://` URL users reach the server at. When set, plain-http requests are refused, HSTS is sent, and OAuth metadata never depends on request headers. |
| `MCP_HTTP_OAUTH_REDIRECT_URIS` | No | - | Comma-separated callback URLs of OAuth clients other than Claude (e.g. Devin), exact match. Claude's callback and loopback are always allowed. Rejected callbacks are logged so you can find the value to add. |
| `PORT` | No | `3000` | Set automatically on Heroku. |
| `MCP_HTTP_MAX_SESSIONS` | No | `10` | Each session is a child process, so size this to the dyno's memory. |
| `MCP_HTTP_SESSION_IDLE_MS` | No | `1800000` | Idle sessions are closed after this long; clients re-initialize. |

`TOGGL_CACHE_TTL`, `TOGGL_CACHE_SIZE`, and `TOGGL_BATCH_SIZE` are forwarded to each session; Toggl tokens set on the server are not.

#### Security notes

- Keep secrets in Heroku config vars (`heroku config:set`), never in the `Procfile`, code, or a committed `.env`.
- Users' Toggl tokens are never stored on the server. They live only in the OAuth token Claude holds (AES-256-GCM sealed) and in the memory of that user's session process.
- Failed access-code, API-key, and token attempts are rate-limited per client IP (10 per 15 minutes).
- Sessions are bound to the credentials that opened them; a different user cannot attach to an existing session even with its ID.

## Tools

### Reports and Insights

| Tool | What it does |
| --- | --- |
| `toggl_daily_report` | Hours by project and workspace for a date. Use `format: "text"` for display text or `"json"` for structured output. |
| `toggl_weekly_report` | 7-day breakdown with daily totals and project rollups. Use `week_offset: -1` for last week. |
| `toggl_get_time_entries` | Raw hydrated entries by period, date range, workspace, or project. |
| `toggl_get_timeline` | Toggl Track Desktop app usage summary with optional raw events. |

### Timer Control

| Tool | What it does |
| --- | --- |
| `toggl_get_current_entry` | Returns the running timer, elapsed seconds, and hydrated project/workspace context. |
| `toggl_start_timer` | Starts a timer with description, optional project/task, and tags. |
| `toggl_stop_timer` | Stops the currently running timer. |

### Entry Management

Added by this fork. See [Fork Additions](#fork-additions).

| Tool | What it does |
| --- | --- |
| `toggl_create_entry` | Creates a completed (past) entry. Takes `start` plus exactly one of `end` or `duration_minutes`, with optional `description`, `project_id`, `client_id`, `task_id`, `tags`, and `billable`. |
| `toggl_search_entries` | Searches entries and returns matches **with their `id`**. Filters combine with AND and include `description`, `project_name`, `client_name`, `tag`, `project_id`, `client_id`, `workspace_id`, `billable`, `start_after`/`start_before`, and `min_duration_minutes`/`max_duration_minutes`. |
| `toggl_delete_entry` | Deletes an entry by `time_entry_id`. `workspace_id` is optional — it is resolved from the entry when omitted. Irreversible. |

**Attaching to a project or client:** Toggl attaches entries to a *project*, not a client directly. If you pass a `client_id` without a `project_id`, the client must have exactly one project (it is resolved for you); when a client has several projects, the tool returns the candidates and asks for a `project_id`.

**Searching:** the date window defaults to roughly the last 31 days. Widen it with `period` (`today`, `week`, `lastMonth`, …) or explicit `start_date`/`end_date`. Results are hydrated with names and sorted newest-first (`limit` defaults to 50, max 1000).

### Lookups

| Tool | What it does |
| --- | --- |
| `toggl_check_auth` | Verifies token access and lists available workspaces without exposing the token. |
| `toggl_list_workspaces` | Lists all accessible workspaces. |
| `toggl_list_projects` | Lists projects for a workspace using cache-backed reads after first fetch. |
| `toggl_list_clients` | Lists clients for a workspace using cache-backed reads after first fetch. |

### Project and Client Management

Added by this fork. See [Fork Additions](#fork-additions).

| Tool | What it does |
| --- | --- |
| `toggl_create_project` | Creates a project. `name` is required; optional `client_id`, `active`, `is_private`, `billable`, `color`, `estimated_hours`, `start_date`, `end_date`, `currency`, `rate`. |
| `toggl_update_project` | Updates a project by `project_id`. Supply at least one field; omitted fields are left untouched. Use `active: false` to archive. |
| `toggl_delete_project` | Deletes a project by `project_id`. Irreversible — prefer archiving. |
| `toggl_create_client` | Creates a client. `name` is required; optional `notes`. |
| `toggl_update_client` | Updates a client by `client_id` (`name`, `notes`, `archived`). Supply at least one field. |
| `toggl_delete_client` | Deletes a client by `client_id`. Irreversible — prefer archiving. |

All six invalidate the workspace's cached project/client lists, so the next list read is fresh.

### Team and Admin

Added by this fork. **Requires workspace admin rights** — see [Fork Additions](#team-and-admin-visibility).

| Tool | What it does |
| --- | --- |
| `toggl_list_users` | Lists **workspace** members with id, name, email, and admin/owner flags. Use the ids as `user_ids` below. |
| `toggl_list_org_users` | Lists **organization** members across all workspaces, with active status, role, org/workspace admin flags, and workspace count. Supports `filter`, `active_status`, `only_admins`. Requires **org** admin. |
| `toggl_team_entries` | Time entries across all users, via the Reports API. Filters: `user_ids`, `project_ids`, `client_ids`, `tag_ids`, `billable`, `description`, `min_duration_minutes`, `max_duration_minutes`. Hydrated with user/project/client names, newest-first (`limit` default 100, max 1000). |
| `toggl_team_summary` | Hours per user for the window — total, billable, entry count, and project count. Sorted by hours descending. |

**Workspace vs organization:** use `toggl_list_users` when you care about one workspace, and `toggl_list_org_users` when you want everyone in the org. `toggl_list_org_users` returns both an `organization_user_id` and a `user_id` — **`user_id` is the one to pass as `user_ids`**, since that's what time entries are keyed by. `organization_id` is resolved from your workspaces automatically (or set `TOGGL_DEFAULT_ORG_ID`); if your workspaces span several orgs, the tool lists them and asks you to pick.

**Date windows here are inclusive on both ends** (`start_date` … `end_date`), matching Toggl's Reports API, and default to the last 31 days.

**Permissions:** Toggl enforces visibility. If your token is not a workspace admin, these tools return only your own data rather than the team's — they will not error loudly, so verify with `toggl_list_users` first.

**Raw responses.** Toggl does not publish a response schema for the users and report endpoints, so `toggl_list_users`, `toggl_list_org_users`, and `toggl_team_entries` return **Toggl's objects unmodified** rather than reshaping them around guessed field names — the assistant reads whatever Toggl actually sends. `toggl_team_entries` includes a `lookups` block (users, projects, clients) so ids can be resolved to names. The one exception is `toggl_team_summary`, which must know where the duration lives in order to add hours up; if it can't read durations from the rows, it returns a `schema_warning` rather than claiming the team logged zero hours.

### Cache Management

| Tool | What it does |
| --- | --- |
| `toggl_warm_cache` | Pre-fetches workspace, project, client, and tag data before a heavy reporting session. |
| `toggl_cache_stats` | Returns hits, misses, hit rate, loaded entity counts, and warm-cache state. |
| `toggl_clear_cache` | Clears cached data. Useful after creating or renaming Toggl entities. |

### Summaries

| Tool | What it does |
| --- | --- |
| `toggl_project_summary` | Total hours per project for a period or date range. |
| `toggl_workspace_summary` | Total hours per workspace for a period or date range. |

## Timeline Privacy

Toggl Track Desktop activity can include window titles. Those titles may contain document names, email subjects, chat text, URLs, OAuth pages, or database names.

Summary-only mode returns app totals without raw events:

```json
{
  "period": "today",
  "include_events": false
}
```

Events with redacted titles preserve sequence and duration but remove titles:

```json
{
  "period": "today",
  "redact_titles": true,
  "limit": 50
}
```

Full event mode is the default:

```json
{
  "period": "today"
}
```

When in doubt, use `include_events: false`.

## Configuration Reference

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `TOGGL_API_KEY` | Yes | - | Preferred env var for your Toggl API token. |
| `TOGGL_API_TOKEN` | No | - | Supported alias for backwards compatibility. `TOGGL_API_KEY` is preferred. |
| `TOGGL_TOKEN` | No | - | Supported alias for backwards compatibility. `TOGGL_API_KEY` is preferred. |
| `TOGGL_DEFAULT_WORKSPACE_ID` | No | - | Used when a tool requires a workspace and none is passed. |
| `TOGGL_DEFAULT_ORG_ID` | No | - | Used by `toggl_list_org_users` when no `organization_id` is passed. Otherwise derived from your workspaces. |
| `TOGGL_CACHE_TTL` | No | `3600000` | Cache TTL in milliseconds. Default is 1 hour. |
| `TOGGL_CACHE_SIZE` | No | `1000` | Maximum cached entity budget. |
| `TOGGL_BATCH_SIZE` | No | `100` | Batch size used by API pagination helpers. |

## Caveats

**Toggl rate limits and quotas**: Toggl may return rate-limit or quota errors during chatty sessions. The server returns structured retry information when Toggl provides it. Warm the cache before large reporting sessions to avoid repeated project/client/tag fetches.

**Running timer duration**: Toggl uses negative duration values for running entries. Read `running` and `elapsed_seconds` from the hydrated response instead.

**Timeline availability**: `toggl_get_timeline` requires Toggl Track Desktop timeline sync. If it is not enabled or has not uploaded data yet, the tool returns `enabled: false` with setup guidance.

**Timeline totals**: `limit` only limits returned raw events. `summary`, `total_seconds`, and `total_hours` are calculated from all matching events.

## Local Development

```bash
git clone https://github.com/yakirmar/mcp-toggl.git
cd mcp-toggl
npm install
npm run build
npm test
```

Useful commands:

```bash
npm run dev
npm run lint
npm run format
```

## License

MIT.

Originally built by [Very Good Plugins](https://verygoodplugins.com). This fork is maintained at [yakirmar/mcp-toggl](https://github.com/yakirmar/mcp-toggl).
