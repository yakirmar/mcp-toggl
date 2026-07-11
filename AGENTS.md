# AGENTS.md

This file provides guidance to coding agents (Claude Code, Cursor, Codex, etc.) when working with this repository. It is the single source of truth; `CLAUDE.md` imports it via `@AGENTS.md`.

## Project Overview

**MCP Toggl** is an MCP (Model Context Protocol) server for [Toggl Track](https://track.toggl.com) time tracking. It lets AI assistants read time entries, start/stop timers, generate daily/weekly/project/workspace reports, list workspaces/projects/clients, and inspect the Toggl Desktop activity timeline — translating MCP tool calls into Toggl Track API v9 requests over stdio.

**Core purpose:**
- Translate MCP tool calls into Toggl Track API requests
- Provide reporting (daily, weekly, per-project, per-workspace hour summaries)
- Cache workspace/project/client/tag metadata to cut API calls and avoid rate limits

This is a single-package TypeScript project (ES modules, Node 20.19+/22.12+). It runs as a stdio MCP server; there are no hooks, queues, or background services.

## Build & Development

```bash
# Install dependencies
npm install

# Development with hot-reload (tsx watch on src/index.ts)
npm run dev

# Build TypeScript to dist/ (removes dist first, then tsc; postbuild chmod +x dist/index.js)
npm run build

# Start the built server (stdio mode)
npm start

# Run tests (Vitest, single run — no watch)
npm test

# Tests with coverage (v8)
npm run test:coverage

# Lint (ESLint over src/ and tests/)
npm run lint

# Format (Prettier over src/**/*.ts)
npm run format

# First-time local setup helper (creates .env from .env.example, installs, builds)
npm run setup
```

The test runner is **Vitest** (`vitest run`). There is no separate integration-test suite — `npm test` runs the full suite and needs no Toggl credentials: HTTP is mocked (`node-fetch` is `vi.mock`-ed in `tests/toggl-api.test.ts`), so tests never hit the live API. `npm run build` does `rm -rf dist && tsc`, and a `postbuild` step marks `dist/index.js` executable so the `mcp-toggl` bin works.

## Commit Standards

This repo uses **Conventional Commits** so Release Please can generate releases and npm/MCP-registry publishes reliably.

- PR titles **must** be Conventional Commit format. The repo squash-merges, so the PR title becomes the merge commit and feeds Release Please. This is enforced in CI by `.github/workflows/pr-title.yml` (there is no local Husky/Commitlint hook).
- Allowed prefixes: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `build`, `ci`, `revert`.
- Use `!` (e.g. `feat!:` or `feat(scope)!:`) for breaking changes → major bump. `feat:` → minor, `fix:` → patch.
- Subjects are imperative mood.

Accepted examples:
```text
fix: convert inclusive end_date to Toggl exclusive range
feat: add toggl_get_timeline activity tool
docs: clarify workspace resolution fallback
chore: bump @modelcontextprotocol/sdk
```

## Commit & PR Guidelines

- **Branches**: short, descriptive names (e.g., `feat/timeline-redaction`, `fix/rate-limit-retry`).
- **PRs**: include a concise summary, motivation, and testing notes (`npm test`, `npm run lint`). Link related issues.
- **CI readiness**: ensure `npm run lint`, `npm run build`, and `npm test` pass locally before pushing — CI runs all three on Node 20, 22, and 24.
- **Never** hand-edit `CHANGELOG.md`, `package.json` version, `.release-please-manifest.json`, or version fields in `server.json` / `src/index.ts` — Release Please owns those.

## Releases

Releases are automated by Release Please (`.github/workflows/release-please.yml`, release-type `node`):

1. Merging Conventional Commits to `main` opens/updates a Release PR.
2. Merging the Release PR bumps `package.json`, updates `CHANGELOG.md`, and tags a GitHub Release. Per `release-please-config.json`, the version is also propagated into `server.json` (`$.version` and `$.packages[0].version`) and `src/index.ts` (the `VERSION` constant).
3. On release (or `workflow_dispatch`) the `npm-publish` job builds, tests, and runs `npm publish --provenance --access public` via OIDC.

## Coding Style & Naming

- **Language**: TypeScript with ES modules (`"type": "module"`); compiles with `module`/`moduleResolution: Node16`, so relative imports use `.js` extensions even for `.ts` sources.
- **Formatting**: Prettier (`.prettierrc`) — semicolons, single quotes, 2-space indent, `printWidth` 100, `trailingComma: es5`.
- **Linting**: ESLint flat config (`eslint.config.mjs`) with `typescript-eslint` recommended. Notable rules: `no-console` is an **error** except `console.error`/`console.warn` (stdout must stay clean for the MCP stdio protocol); unused vars/args prefixed `_` are allowed; `no-explicit-any` is a warning.
- **Naming**: `camelCase` for variables/functions, `PascalCase` for classes/types, kebab-case file names (e.g., `toggl-api.ts`, `cache-manager.ts`). MCP tool names are snake_case, all prefixed `toggl_`.

## Architecture

```
┌──────────────────────────────────────────┐
│  MCP Client (Claude Code / Cursor / etc.) │
│  - Calls MCP tools over stdio             │
└─────────────┬────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────┐
│  MCP Toggl Server (this TypeScript app)   │
│  - Translates MCP tool calls → Toggl API  │
│  - In-memory TTL cache for metadata       │
└─────────────┬────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────┐
│  Toggl Track API (REST)                   │
│  - api.track.toggl.com/api/v9 (core)      │
│  - track.toggl.com/api/v9/timeline        │
│  - api.track.toggl.com/reports/api/v3     │
│      (team/admin cross-user reports)      │
│  - HTTP Basic auth (token : api_token)    │
└──────────────────────────────────────────┘
```

### Code Organization

```
src/
├── index.ts           # MCP server entry point: tool schemas, CallTool handlers, env/config load, CLI --help/--version
├── toggl-api.ts        # Toggl Track API v9 HTTP client (TogglAPI); Basic auth, retry/backoff, rate-limit (429) & quota (402) handling; TogglAPIError / TimelineNotEnabledError
├── cache-manager.ts    # CacheManager: in-memory TTL cache for workspaces/projects/clients/tasks/tags; warmCache, hydrateTimeEntries, stats
├── workspace.ts        # resolveWorkspaceId / parseWorkspaceId; WorkspaceResolutionError when workspace is ambiguous
├── timeline.ts         # buildTimelineResponse: filters/clips/redacts Toggl Desktop timeline events, builds per-app summary
├── reports.ts          # normalizeReportRows / summarizeByUser / userDisplayName: defensively flattens Reports API v3 rows (schema is unpublished) into per-user team entries and summaries
├── utils.ts            # Date helpers (local YMD parse/format, period→range, reportDateWindow), report generators, grouping, duration formatting, pickDefined
└── types.ts            # TypeScript interfaces (TimeEntry, Workspace, Project, CacheConfig, TimelineEvent, WorkspaceUser, ReportRow, TeamEntry, etc.)

scripts/setup.js        # One-time local setup CLI (npm run setup)
tests/                  # Vitest suites (cache-manager, reports, timeline, toggl-api, utils, workspace, stdio-smoke)
server.json             # MCP registry manifest (mirrors the tool names; version kept in sync by Release Please)
```

Build output lands in `dist/` (do not edit directly); `dist/index.js` is the CLI entry exposed as the `mcp-toggl` bin.

## MCP Tools

The server registers **28 tools**, all prefixed `toggl_`, defined in the `tools` array in `src/index.ts` and dispatched by the `CallToolRequestSchema` switch. (`server.json` lists the same 28.) This list reflects v1.1.0 of this repo.

**Health / auth**
1. **toggl_check_auth** — Verify API connectivity and auth; returns the (email-masked) user and accessible workspaces.

**Time tracking**
2. **toggl_get_time_entries** — Get time entries by `period` (`today`/`yesterday`/`week`/`lastWeek`/`month`/`lastMonth`) or `start_date`/`end_date`; optional `workspace_id`/`project_id` filters. Returns entries hydrated with project/workspace names.
3. **toggl_get_current_entry** — Get the currently running time entry, if any.
4. **toggl_start_timer** — Start a timer (`description`, `workspace_id`, `project_id`, `task_id`, `tags`). Workspace resolved per the rule below.
5. **toggl_stop_timer** — Stop the currently running timer.
6. **toggl_create_entry** — Create a completed (past) time entry. Attaches to a `project_id` and/or `client_id` (a client resolves to its single project, or requires `project_id` when it has several); takes `start` plus exactly one of `end` or `duration_minutes` (ISO 8601 datetimes; bare `YYYY-MM-DD` = local midnight); optional `description`, `task_id`, `tags`, `billable`. Workspace resolved per the rule below. Use `toggl_start_timer` for a running timer instead.
7. **toggl_search_entries** — Search entries and return matches **with their id** (feed into `toggl_delete_entry`). Filters combine with AND: `description`/`project_name`/`client_name`/`tag` (case-insensitive substring), `project_id`/`client_id`/`workspace_id` (exact), `billable`, `start_after`/`start_before` (ISO 8601), `min_duration_minutes`/`max_duration_minutes`. Date window via `period` or `start_date`/`end_date` (defaults to ~last 31 days). Hydrated, sorted newest-first, `limit` default 50 / max 1000.
8. **toggl_delete_entry** — Delete a time entry by `time_entry_id` (required). `workspace_id` optional — resolved from the entry when omitted. Irreversible.

**Reporting**
9. **toggl_daily_report** — Daily report (`date`, `format` `json`|`text`) with hours by project and workspace.
10. **toggl_weekly_report** — Weekly report (`week_offset`, `format`) with daily breakdown and project summaries.
11. **toggl_project_summary** — Total hours per project for a `period` or date range (optional `workspace_id`).
12. **toggl_workspace_summary** — Total hours per workspace for a `period` or date range.

**Management**
13. **toggl_list_workspaces** — List all available workspaces.
14. **toggl_list_projects** — List projects for a workspace.
15. **toggl_list_clients** — List clients for a workspace.
16. **toggl_create_project** — Create a project (`name` required; optional `client_id`, `active`, `is_private`, `billable`, `color`, `estimated_hours`, `start_date`, `end_date`, `currency`, `rate`).
17. **toggl_update_project** — Update a project by `project_id`; supply at least one updatable field. Omitted fields are left untouched. `active: false` archives.
18. **toggl_delete_project** — Delete a project by `project_id`. Irreversible; prefer archiving via `toggl_update_project`.
19. **toggl_create_client** — Create a client (`name` required; optional `notes`).
20. **toggl_update_client** — Update a client by `client_id`; supply at least one updatable field (`name`, `notes`, `archived`).
21. **toggl_delete_client** — Delete a client by `client_id`. Irreversible; prefer archiving via `toggl_update_client`.

**Cache management**
**Team / admin (workspace-wide, require admin rights)**
22. **toggl_list_users** — Workspace members (id, name, email, admin/owner flags). Admin-only; non-admin tokens typically get 403.
23. **toggl_team_entries** — Time entries for *other* users via the **Reports API v3** (`/reports/api/v3/workspace/{id}/search/time_entries`). `/me/time_entries` is self-scoped, so this is the only way to read other users' entries. Filters: `user_ids`, `project_ids`, `client_ids`, `tag_ids`, `billable`, `description`, `min`/`max_duration_minutes`. Hydrated with user/project/client names, newest-first, `limit` default 100.
24. **toggl_team_summary** — Hours per user (total, billable, project count) for the window. Derived by aggregating the detailed report, not the separate summary endpoint.

**Cache management**
25. **toggl_warm_cache** — Pre-fetch and cache workspace, project, client, and tag data.
26. **toggl_cache_stats** — Cache statistics and hit-rate metrics.
27. **toggl_clear_cache** — Clear all cached data.

**Timeline**
28. **toggl_get_timeline** — Toggl Desktop activity timeline (app usage). `period` or `start_date`/`end_date`, `app` filter, `include_events` (default true), `redact_titles` (default false; nulls window titles), `limit` (default 50, max 1000; affects the events array only, never the summary). **Privacy:** raw events include window titles that may contain sensitive content — use `include_events: false` or `redact_titles: true` for privacy-conscious use. Returns `enabled: false` with guidance if Toggl Desktop timeline sync is not enabled.

## Environment Variables

Loaded from the environment or a local `.env` file via `dotenv` (`config({ quiet: true })` in `src/index.ts`).

**Authentication (required — one of these aliases)** — checked in precedence order `TOGGL_API_KEY || TOGGL_API_TOKEN || TOGGL_TOKEN` (`src/index.ts:127`). The value is `.trim()`-ed; if none is set the server prints an error and **exits** (`src/index.ts:131-135`). Using a legacy alias logs a deprecation warning to stderr (`src/index.ts:137-138`).

| Variable | Default | Purpose |
|----------|---------|---------|
| `TOGGL_API_KEY` | — (required) | Toggl Track API token. **Preferred** name. |
| `TOGGL_API_TOKEN` | — | Deprecated alias for the API token (fallback). |
| `TOGGL_TOKEN` | — | Deprecated alias for the API token (fallback). |

**Optional**

| Variable | Default | Purpose |
|----------|---------|---------|
| `TOGGL_DEFAULT_WORKSPACE_ID` | unset (`undefined`) | Default workspace for tools that need one (`src/index.ts:148`). |
| `TOGGL_CACHE_TTL` | `3600000` (ms = 1h) | Cache time-to-live (`src/index.ts:143`). |
| `TOGGL_CACHE_SIZE` | `1000` | Max cached entities (`src/index.ts:144`). |
| `TOGGL_BATCH_SIZE` | `100` | Entries fetched per request (`src/index.ts:145`). |

> Note: the API token is sent as HTTP **Basic auth** with the token as the username and the literal string `api_token` as the password (`src/toggl-api.ts:63`), not as a bearer token. There is **no** `TOGGL_WORKSPACE_ID` variable — the default-workspace var is `TOGGL_DEFAULT_WORKSPACE_ID`.

## Key Patterns

**Workspace resolution** (`src/workspace.ts`): tools needing a workspace resolve it as explicit `workspace_id` arg → `TOGGL_DEFAULT_WORKSPACE_ID` → the sole workspace if exactly one exists → otherwise throw `WorkspaceResolutionError` (`code: WORKSPACE_REQUIRED`) listing available workspaces. `parseWorkspaceId` accepts only positive integers; anything else becomes `undefined`.

**Dates are inclusive at the tool boundary** but Toggl's API treats `end_date` as exclusive. `parseInclusiveEndDate` (`src/index.ts:30`) adds one day, and all ranges are computed in **local** time via `parseLocalYMD`/`toLocalYMD` (`src/utils.ts`). Date inputs use `YYYY-MM-DD`.

**Caching** (`src/cache-manager.ts`): in-memory TTL maps for workspaces/projects/clients/tasks/tags; `hydrateTimeEntries` attaches project/workspace names. Project/client **mutations must invalidate the cache** or reads serve a stale list for the rest of the TTL: the create/update/delete handlers call `cache.invalidateProjects(workspaceId)` / `cache.invalidateClients(workspaceId)` (the latter also invalidates projects, since a project's `client_id`/`client_name` can be orphaned by a client change). On first tool use `ensureCache` (`src/index.ts:159`) pre-warms project/client/tag data **only when it can resolve a workspace** — `TOGGL_DEFAULT_WORKSPACE_ID`, or exactly one accessible workspace. With multiple workspaces and no default set, it marks the cache warmed without pre-fetching, so those entities are fetched lazily on the first tool that resolves a workspace.

**Error handling** (`src/toggl-api.ts`): `request()` retries transient/5xx/network errors with backoff but not 4xx (`noRetry`). 429 honors `Retry-After` (auto-retries only if the delay ≤ 30s, else throws `RATE_LIMITED`); 402 surfaces `TOGGL_QUOTA_LIMIT` with reset seconds. Tool handlers catch everything and return a structured `errorPayload` (never throw across the MCP boundary).

**Team / admin reads** (`src/reports.ts`, `TogglAPI.searchDetailedReport`): `/me/time_entries` is **self-scoped** — it returns only the token owner's entries regardless of admin rights. Reading *other* users' entries requires the **Reports API v3** on a different base URL (`api.track.toggl.com/reports/api/v3`), which pages via the `X-Next-Row-Number` response header (hence `requestAbsolute` surfacing headers). Two traps: (1) **Reports API dates are INCLUSIVE**, unlike core v9's exclusive `end_date` — use `reportDateWindow` (`src/utils.ts`), never `parseInclusiveEndDate`; (2) Toggl **does not publish the report response schema**, so `normalizeReportRows` treats every field as optional and falls back (row-level timing when `time_entries` is absent, `row.username` when the user map is empty). `toggl_team_summary` is derived by aggregating the detailed report rather than calling the separate summary endpoint, so there is only one unverified shape to depend on. Listing workspace users requires admin; `workspaceUserNames` degrades to an empty map on 403 instead of failing the whole call.

**Stdio hygiene**: this is a stdio server — never write to stdout outside protocol responses. Use `console.error`/`console.warn` for logs (enforced by the `no-console` lint rule).

## Common Tasks

**Add a new tool:**
1. Append a schema object (`name`, `description`, `annotations`, `inputSchema`) to the `tools` array in `src/index.ts`.
2. Add a matching `case '<name>':` in the `CallToolRequestSchema` switch.
3. Add the underlying call as a method on `TogglAPI` in `src/toggl-api.ts` if a new API request is needed.
4. Add/extend types in `src/types.ts`; add tests under `tests/`.
5. Add the tool name + short description to `server.json` to keep the registry manifest in sync.

**Test a tool over stdio:**
```bash
npm run build
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"toggl_check_auth","arguments":{}},"id":1}' | TOGGL_API_KEY=... npm start
```

## CI

Every PR to `main` runs (`.github/workflows/`), all blocking:
- **CI** (`ci.yml`): `npm run lint`, `npm run build`, `npm test` on Node 20, 22, and 24.
- **PR Title** (`pr-title.yml`): Conventional Commit title check.
- **Security** (`security.yml`): CodeQL (TypeScript) and `npm audit --audit-level=high` (`continue-on-error: false`).

## Memory MCP Usage

- **Start of work**: recall project-specific context for the area you are modifying (recent bugs, decisions, related files).
- **During/after work**: when you fix an issue or learn something important (API behavior, edge case, configuration nuance), store or update a memory.
- **Associations**: link new memories to existing ones (e.g., a bugfix to a module or decision) to keep context navigable for future tasks.
