#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from 'dotenv';
import { TogglAPI, TimelineNotEnabledError, TogglAPIError } from './toggl-api.js';
import { buildTimelineResponse } from './timeline.js';
import { normalizeReportRows, summarizeByUser, userDisplayName } from './reports.js';
import { CacheManager } from './cache-manager.js';
import {
  WorkspaceResolutionError,
  parseWorkspaceId,
  resolveWorkspaceId,
  resolveProjectForClient,
} from './workspace.js';
import {
  OrganizationResolutionError,
  parseOrganizationId,
  resolveOrganizationId,
} from './organization.js';
import {
  buildTimeEntryInterval,
  filterHydratedEntries,
  pickDefined,
  getDateRange,
  generateDailyReport,
  generateWeeklyReport,
  formatReportForDisplay,
  secondsToHours,
  groupEntriesByProject,
  groupEntriesByWorkspace,
  generateProjectSummary,
  generateWorkspaceSummary,
  toLocalYMD,
  parseLocalYMD,
  localDateRangeFromArgs,
  reportDateWindow,
} from './utils.js';
import type {
  CacheConfig,
  TimelineEvent,
  TimeEntry,
  CreateProjectRequest,
  UpdateProjectRequest,
  CreateClientRequest,
  UpdateClientRequest,
  ReportSearchParams,
  ReportRow,
} from './types.js';

function parseInclusiveEndDate(value: string): Date {
  const date = parseLocalYMD(value);
  date.setDate(date.getDate() + 1);
  return date;
}

// Parse a required positive-integer entity id from tool arguments.
function requireId(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} is required and must be a positive integer.`);
  }
  return parsed;
}

function requireName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required and must be a non-empty string.`);
  }
  return value.trim();
}

// Fields a caller may set when creating or updating a project / client.
const PROJECT_FIELDS = [
  'name',
  'client_id',
  'active',
  'is_private',
  'billable',
  'color',
  'estimated_hours',
  'start_date',
  'end_date',
  'currency',
  'rate',
] as const;

const CLIENT_FIELDS = ['name', 'notes', 'archived'] as const;

function jsonResponse(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An error occurred';
}

function errorPayload(error: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    error: true,
    message: errorMessage(error),
  };

  if (error instanceof TogglAPIError) {
    payload.code = error.code;
    payload.status = error.status;
    if (error.retry_after_seconds !== undefined) {
      payload.retry_after_seconds = error.retry_after_seconds;
    }
    if (error.tip) {
      payload.tip = error.tip;
    }
  }

  if (error instanceof WorkspaceResolutionError) {
    payload.code = error.code;
    payload.tip = error.tip;
    payload.available_workspaces = error.available_workspaces;
  }

  if (error instanceof OrganizationResolutionError) {
    payload.code = error.code;
    payload.tip = error.tip;
    payload.available_organizations = error.available_organizations;
  }

  return payload;
}

// Version for CLI output and server metadata
const VERSION = '1.2.0';

// Basic CLI flags: --help / -h and --version / -v
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  console.error(`mcp-toggl version ${VERSION}`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.error(
    `mcp-toggl - Toggl MCP Server\n\n` +
      `Usage:\n` +
      `  npx @yakirmar/mcp-toggl@latest [--help] [--version]\n\n` +
      `Environment:\n` +
      `  TOGGL_API_KEY                Required Toggl API token\n` +
      `  TOGGL_DEFAULT_WORKSPACE_ID   Optional default workspace id\n` +
      `  TOGGL_CACHE_TTL              Cache TTL in ms (default: 3600000)\n` +
      `  TOGGL_CACHE_SIZE             Max cached entities (default: 1000)\n\n` +
      `Claude Desktop (claude_desktop_config.json):\n` +
      `  {\n` +
      `    "mcpServers": {\n` +
      `      "mcp-toggl": {\n` +
      `        "command": "npx @yakirmar/mcp-toggl@latest",\n` +
      `        "env": { "TOGGL_API_KEY": "your_api_key_here" }\n` +
      `      }\n` +
      `    }\n` +
      `  }\n\n` +
      `Cursor (~/.cursor/mcp.json):\n` +
      `  {\n` +
      `    "mcp": {\n` +
      `      "servers": {\n` +
      `        "mcp-toggl": {\n` +
      `          "command": "npx",\n` +
      `          "args": ["@yakirmar/mcp-toggl@latest"],\n` +
      `          "env": { "TOGGL_API_KEY": "your_api_key_here" }\n` +
      `        }\n` +
      `      }\n` +
      `    }\n` +
      `  }\n`
  );
  process.exit(0);
}

// Load environment variables
config({ quiet: true });

// Validate required environment variables
// Support a few aliases for convenience/backward-compat
const RAW_API_KEY =
  process.env.TOGGL_API_KEY || process.env.TOGGL_API_TOKEN || process.env.TOGGL_TOKEN;

const API_KEY = RAW_API_KEY?.trim();

if (!API_KEY) {
  console.error('Missing required environment variable: TOGGL_API_KEY');
  console.error('Also accepted: TOGGL_API_TOKEN or TOGGL_TOKEN');
  process.exit(1);
}

if (process.env.TOGGL_API_TOKEN || process.env.TOGGL_TOKEN) {
  console.warn('Using TOGGL_API_TOKEN/TOGGL_TOKEN. Prefer TOGGL_API_KEY going forward.');
}

// Initialize configuration
const cacheConfig: CacheConfig = {
  ttl: parseInt(process.env.TOGGL_CACHE_TTL || '3600000'),
  maxSize: parseInt(process.env.TOGGL_CACHE_SIZE || '1000'),
  batchSize: parseInt(process.env.TOGGL_BATCH_SIZE || '100'),
};

const defaultWorkspaceId = parseWorkspaceId(process.env.TOGGL_DEFAULT_WORKSPACE_ID);
const defaultOrganizationId = parseOrganizationId(process.env.TOGGL_DEFAULT_ORG_ID);

// Initialize API and cache
const api = new TogglAPI(API_KEY);
const cache = new CacheManager(cacheConfig);
cache.setAPI(api);

// Track if cache has been warmed
let cacheWarmed = false;

// Helper to ensure cache is warm
async function ensureCache(): Promise<void> {
  if (!cacheWarmed) {
    try {
      const workspaces = await cache.getWorkspaces();
      const singleWorkspaceId = workspaces.length === 1 ? workspaces[0]!.id : undefined;
      const workspaceIdToWarm = defaultWorkspaceId || singleWorkspaceId;
      if (workspaceIdToWarm) {
        await cache.warmCache(workspaceIdToWarm);
      }
      cacheWarmed = true;
    } catch (error) {
      console.error('Failed to warm cache:', error);
    }
  }
}

async function resolveWorkspaceForTool(
  args: Record<string, unknown> | undefined,
  action: string
): Promise<number> {
  return resolveWorkspaceId({
    explicitWorkspaceId: args?.workspace_id,
    defaultWorkspaceId,
    getWorkspaces: () => cache.getWorkspaces(),
    action,
  });
}

async function resolveOrganizationForTool(
  args: Record<string, unknown> | undefined,
  action: string
): Promise<number> {
  return resolveOrganizationId({
    explicitOrganizationId: args?.organization_id,
    defaultOrganizationId,
    getWorkspaces: () => cache.getWorkspaces(),
    action,
  });
}

// Workspace member id -> display name. Requires admin rights; when the token
// lacks them we degrade to the username Toggl embeds in each report row rather
// than failing the whole call.
async function workspaceUserNames(workspaceId: number): Promise<Map<number, string>> {
  try {
    const users = await api.getWorkspaceUsers(workspaceId);
    return new Map(users.map((user) => [user.id, userDisplayName(user)]));
  } catch (error) {
    console.error(
      `Could not list users for workspace ${workspaceId} (admin rights required):`,
      error
    );
    return new Map();
  }
}

const REPORT_FILTER_FIELDS = [
  'user_ids',
  'project_ids',
  'client_ids',
  'tag_ids',
  'task_ids',
  'billable',
  'description',
] as const;

// Shared path for both team tools: pull the cross-user detailed report and the
// reference data needed to make sense of the ids inside it. The rows themselves
// are left untouched — the Reports API response schema is not published.
async function fetchTeamReport(
  workspaceId: number,
  args: Record<string, unknown> | undefined
): Promise<{
  rows: ReportRow[];
  window: { start_date: string; end_date: string };
  truncated: boolean;
  users: Array<{ id: number; name: string }>;
  projects: Array<{ id: number; name: string; client_id?: number }>;
  clients: Array<{ id: number; name: string }>;
}> {
  const window = reportDateWindow(args);

  const params: ReportSearchParams = {
    ...pickDefined<ReportSearchParams>(args ?? {}, REPORT_FILTER_FIELDS),
    start_date: window.start_date,
    end_date: window.end_date,
  };

  const minMinutes = args?.min_duration_minutes;
  if (typeof minMinutes === 'number') params.min_duration_seconds = Math.round(minMinutes * 60);
  const maxMinutes = args?.max_duration_minutes;
  if (typeof maxMinutes === 'number') params.max_duration_seconds = Math.round(maxMinutes * 60);

  const [{ rows, truncated }, userNames, projects, clients] = await Promise.all([
    api.searchDetailedReport(workspaceId, params),
    workspaceUserNames(workspaceId),
    cache.getProjects(workspaceId),
    cache.getClients(workspaceId),
  ]);

  return {
    rows,
    window,
    truncated,
    users: [...userNames].map(([id, name]) => ({ id, name })),
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      client_id: project.client_id,
    })),
    clients: clients.map((client) => ({ id: client.id, name: client.name })),
  };
}

// Create MCP server
const server = new Server(
  {
    name: 'mcp-toggl',
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tool schemas
const tools: Tool[] = [
  // Health/authentication
  {
    name: 'toggl_check_auth',
    description: 'Verify Toggl API connectivity and authentication is valid',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  // Time tracking tools
  {
    name: 'toggl_get_time_entries',
    description:
      'Get time entries with optional date range filters. Returns hydrated entries with project/workspace names.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period to fetch entries for',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        workspace_id: {
          type: 'number',
          description: 'Filter by workspace ID',
        },
        project_id: {
          type: 'number',
          description: 'Filter by project ID',
        },
      },
    },
  },
  {
    name: 'toggl_get_current_entry',
    description: 'Get the currently running time entry, if any',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggl_start_timer',
    description: 'Start a new time entry timer',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Description of the time entry',
        },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
        project_id: {
          type: 'number',
          description: 'Project ID (optional)',
        },
        task_id: {
          type: 'number',
          description: 'Task ID (optional)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the entry',
        },
      },
    },
  },
  {
    name: 'toggl_stop_timer',
    description: 'Stop the currently running timer',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggl_create_entry',
    description:
      'Create a completed (past) time entry for a project, optionally scoped to a client, with a start time and either an end time or a length in minutes. ' +
      'Times are ISO 8601 datetimes: use Z or an offset (2026-07-11T09:00:00Z / 2026-07-11T09:00:00+03:00) for an absolute time, omit the offset for the host local timezone, or pass a bare YYYY-MM-DD for local midnight. ' +
      'Provide exactly one of end or duration_minutes. Use toggl_start_timer instead to begin a currently-running timer.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Description of the time entry',
        },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
        project_id: {
          type: 'number',
          description: 'Project to attach the entry to (optional).',
        },
        client_id: {
          type: 'number',
          description:
            'Client to attach the entry to (optional). Toggl entries attach to a project, not a client directly: when set without project_id the client must have exactly one project; when both are set the project must belong to this client.',
        },
        task_id: {
          type: 'number',
          description: 'Task ID (optional).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the entry',
        },
        billable: {
          type: 'boolean',
          description: 'Whether the entry is billable (optional).',
        },
        start: {
          type: 'string',
          description: 'Start time as an ISO 8601 datetime (required).',
        },
        end: {
          type: 'string',
          description: 'End time as an ISO 8601 datetime. Provide this or duration_minutes.',
        },
        duration_minutes: {
          type: 'number',
          description: 'Length of the entry in minutes. Provide this or end.',
        },
      },
      required: ['start'],
    },
  },
  {
    name: 'toggl_search_entries',
    description:
      'Search time entries and return matches including their id (use the id with toggl_delete_entry). ' +
      'All filters combine with AND; text filters (description, project_name, client_name, tag) are case-insensitive substring matches. ' +
      'Date window: pass period or start_date/end_date (YYYY-MM-DD, inclusive, local); defaults to roughly the last 31 days. ' +
      'start_after/start_before further narrow by entry start time (ISO 8601 datetime). ' +
      'Results are hydrated with project/workspace/client/tag names and sorted newest-first.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Case-insensitive substring match on the entry description.',
        },
        project_name: {
          type: 'string',
          description: 'Case-insensitive substring match on the project name.',
        },
        client_name: {
          type: 'string',
          description: 'Case-insensitive substring match on the client name.',
        },
        project_id: {
          type: 'number',
          description: 'Exact project id to match.',
        },
        client_id: {
          type: 'number',
          description: 'Exact client id to match.',
        },
        workspace_id: {
          type: 'number',
          description: 'Exact workspace id to match.',
        },
        tag: {
          type: 'string',
          description: 'Case-insensitive substring match against any of the entry tags.',
        },
        billable: {
          type: 'boolean',
          description: 'Match only billable (true) or non-billable (false) entries.',
        },
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined date window to search within (alternative to start_date/end_date).',
        },
        start_date: {
          type: 'string',
          description: 'Window start (YYYY-MM-DD, inclusive, local timezone).',
        },
        end_date: {
          type: 'string',
          description: 'Window end (YYYY-MM-DD, inclusive, local timezone).',
        },
        start_after: {
          type: 'string',
          description: 'Only entries starting at or after this ISO 8601 datetime.',
        },
        start_before: {
          type: 'string',
          description: 'Only entries starting at or before this ISO 8601 datetime.',
        },
        min_duration_minutes: {
          type: 'number',
          description: 'Only entries at least this many minutes long.',
        },
        max_duration_minutes: {
          type: 'number',
          description: 'Only entries at most this many minutes long.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 1000,
          default: 50,
          description: 'Maximum number of matches to return (default: 50, max: 1000).',
        },
      },
    },
  },
  {
    name: 'toggl_delete_entry',
    description:
      'Delete a time entry by its id. If workspace_id is omitted it is resolved from the entry itself. ' +
      'Use toggl_search_entries first to find the id when you do not already have it. This cannot be undone.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        time_entry_id: {
          type: 'number',
          description: 'Id of the time entry to delete (required).',
        },
        workspace_id: {
          type: 'number',
          description: 'Workspace the entry belongs to. If omitted, it is looked up from the entry.',
        },
      },
      required: ['time_entry_id'],
    },
  },

  // Reporting tools
  {
    name: 'toggl_daily_report',
    description: 'Generate a daily report with hours by project and workspace',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date for report (YYYY-MM-DD format, defaults to today)',
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format (default: json)',
        },
      },
    },
  },
  {
    name: 'toggl_weekly_report',
    description: 'Generate a weekly report with daily breakdown and project summaries',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        week_offset: {
          type: 'number',
          description: 'Week offset from current week (0 = this week, -1 = last week)',
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format (default: json)',
        },
      },
    },
  },
  {
    name: 'toggl_project_summary',
    description: 'Get total hours per project for a date range',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        workspace_id: {
          type: 'number',
          description: 'Filter by workspace ID',
        },
      },
    },
  },
  {
    name: 'toggl_workspace_summary',
    description: 'Get total hours per workspace for a date range',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format, inclusive, local timezone)',
        },
      },
    },
  },

  // Management tools
  {
    name: 'toggl_list_workspaces',
    description: 'List all available workspaces',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggl_list_projects',
    description: 'List projects for a workspace',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
    },
  },
  {
    name: 'toggl_list_clients',
    description: 'List clients for a workspace',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
    },
  },
  {
    name: 'toggl_create_project',
    description:
      'Create a project in a workspace. Only name is required; optionally attach it to a client and set billing, color, dates, and rate.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name (required).' },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
        client_id: { type: 'number', description: 'Client to attach the project to (optional).' },
        active: { type: 'boolean', description: 'Whether the project is active (default: true).' },
        is_private: { type: 'boolean', description: 'Whether the project is private.' },
        billable: { type: 'boolean', description: 'Whether the project is billable.' },
        color: { type: 'string', description: 'Project color as a hex string, e.g. "#0b83d9".' },
        estimated_hours: { type: 'number', description: 'Estimated hours for the project.' },
        start_date: { type: 'string', description: 'Project start date (YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'Project end date (YYYY-MM-DD).' },
        currency: { type: 'string', description: 'Currency code, e.g. "USD".' },
        rate: { type: 'number', description: 'Hourly rate for the project.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'toggl_update_project',
    description:
      'Update an existing project. Provide project_id plus at least one field to change; omitted fields are left untouched.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project to update (required).' },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
        name: { type: 'string', description: 'New project name.' },
        client_id: {
          type: 'number',
          description: 'Move the project to this client.',
        },
        active: {
          type: 'boolean',
          description: 'Set false to archive the project, true to reactivate it.',
        },
        is_private: { type: 'boolean', description: 'Whether the project is private.' },
        billable: { type: 'boolean', description: 'Whether the project is billable.' },
        color: { type: 'string', description: 'Project color as a hex string.' },
        estimated_hours: { type: 'number', description: 'Estimated hours for the project.' },
        start_date: { type: 'string', description: 'Project start date (YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'Project end date (YYYY-MM-DD).' },
        currency: { type: 'string', description: 'Currency code.' },
        rate: { type: 'number', description: 'Hourly rate for the project.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'toggl_delete_project',
    description:
      'Delete a project by id. This cannot be undone; time entries on the project lose their project association. To keep history, prefer toggl_update_project with active: false to archive it instead.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project to delete (required).' },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'toggl_create_client',
    description: 'Create a client in a workspace.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Client name (required).' },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
        notes: { type: 'string', description: 'Free-form notes for the client (optional).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'toggl_update_client',
    description:
      'Update an existing client. Provide client_id plus at least one field to change; omitted fields are left untouched. Set archived: true to archive.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'number', description: 'Client to update (required).' },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
        name: { type: 'string', description: 'New client name.' },
        notes: { type: 'string', description: 'Free-form notes for the client.' },
        archived: { type: 'boolean', description: 'Archive (true) or unarchive (false).' },
      },
      required: ['client_id'],
    },
  },
  {
    name: 'toggl_delete_client',
    description:
      'Delete a client by id. This cannot be undone; projects belonging to the client lose their client association. To keep history, prefer toggl_update_client with archived: true instead.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'number', description: 'Client to delete (required).' },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
      required: ['client_id'],
    },
  },

  // Team / admin tools (workspace-wide, require admin rights)
  {
    name: 'toggl_list_users',
    description:
      'List the members of a workspace (id, name, email, admin/owner flags). ADMIN ONLY: requires admin rights on the workspace; a non-admin token typically gets a 403. Use the returned ids as user_ids for toggl_team_entries / toggl_team_summary.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
    },
  },
  {
    name: 'toggl_list_org_users',
    description:
      'List the members of an ORGANIZATION (across all its workspaces), with richer data than toggl_list_users: org/workspace admin flags, active status, role, and how many workspaces each member belongs to. ORG ADMIN ONLY. If organization_id is omitted it is derived from your workspaces (or TOGGL_DEFAULT_ORG_ID). Use the returned user_id values as user_ids for toggl_team_entries / toggl_team_summary. Prefer toggl_list_users when you only care about one workspace.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: {
          type: 'number',
          description:
            'Organization ID. If omitted, uses TOGGL_DEFAULT_ORG_ID or the only organization derivable from your workspaces.',
        },
        filter: {
          type: 'string',
          description: 'Free-text filter on name/email, applied by Toggl.',
        },
        active_status: {
          type: 'string',
          description: 'Filter by active status as supported by Toggl, e.g. "active" or "inactive".',
        },
        only_admins: {
          type: 'boolean',
          description: 'Return only organization admins.',
        },
      },
    },
  },
  {
    name: 'toggl_team_entries',
    description:
      "Get time entries for OTHER users in the workspace (what your team worked on), via the Toggl Reports API. ADMIN ONLY: what you can see is enforced by Toggl — a non-admin token sees only its own data. PRIVACY: this returns teammates' entry descriptions. Filter with user_ids (from toggl_list_users), project_ids, client_ids, tag_ids, billable, or description. Date window via period or start_date/end_date (INCLUSIVE; defaults to the last 31 days). Entries are hydrated with user/project/client names and sorted newest-first.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
        user_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Only entries by these user ids. Omit for all visible users.',
        },
        project_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Only entries on these project ids.',
        },
        client_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Only entries for these client ids.',
        },
        tag_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Only entries carrying these tag ids.',
        },
        description: {
          type: 'string',
          description: 'Filter by entry description (matched by Toggl).',
        },
        billable: { type: 'boolean', description: 'Only billable (true) or non-billable (false).' },
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined date window (alternative to start_date/end_date).',
        },
        start_date: {
          type: 'string',
          description: 'Window start (YYYY-MM-DD, inclusive, local timezone).',
        },
        end_date: {
          type: 'string',
          description: 'Window end (YYYY-MM-DD, inclusive, local timezone).',
        },
        min_duration_minutes: {
          type: 'number',
          description: 'Only entries at least this many minutes long.',
        },
        max_duration_minutes: {
          type: 'number',
          description: 'Only entries at most this many minutes long.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 1000,
          default: 100,
          description: 'Maximum entries to return (default: 100, max: 1000).',
        },
      },
    },
  },
  {
    name: 'toggl_team_summary',
    description:
      'Total hours per user across the workspace for a period — who logged how much, how much was billable, and across how many projects. ADMIN ONLY: requires admin rights; a non-admin token sees only its own totals. Accepts the same filters and date window as toggl_team_entries (dates INCLUSIVE; defaults to the last 31 days). Sorted by total hours descending.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
        user_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Only these user ids. Omit for all visible users.',
        },
        project_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Only entries on these project ids.',
        },
        client_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Only entries for these client ids.',
        },
        billable: { type: 'boolean', description: 'Only billable (true) or non-billable (false).' },
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined date window (alternative to start_date/end_date).',
        },
        start_date: {
          type: 'string',
          description: 'Window start (YYYY-MM-DD, inclusive, local timezone).',
        },
        end_date: {
          type: 'string',
          description: 'Window end (YYYY-MM-DD, inclusive, local timezone).',
        },
      },
    },
  },

  // Cache management
  {
    name: 'toggl_warm_cache',
    description:
      'Pre-fetch and cache workspace, project, client, and tag data for better performance',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID to warm. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
    },
  },
  {
    name: 'toggl_cache_stats',
    description: 'Get cache statistics and performance metrics',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggl_clear_cache',
    description: 'Clear all cached data',
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggl_get_timeline',
    description:
      'Get Toggl Desktop activity timeline showing application usage. PRIVACY NOTE: raw events include window titles that may contain sensitive document names, email subjects, chat text, URLs, OAuth pages, or database names; use include_events: false for privacy-conscious summary-only usage. Requires Toggl Track Desktop timeline sync to be enabled. Response semantics: summary is { [appName: string]: total_seconds }; total_events is the post-filter event count; returned_events is the returned events array length; truncated means only the events array was limited, never the summary. limit does not affect summary calculation. total_seconds is canonical; total_hours is rounded to 4 decimals for display.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period (alternative to start_date/end_date)',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        app: {
          type: 'string',
          description: 'Filter by application name, case-insensitive partial match',
        },
        include_events: {
          type: 'boolean',
          description: 'Include raw events array (default: true). Set false for summary only.',
        },
        redact_titles: {
          type: 'boolean',
          default: false,
          description:
            'When true, returned events keep app name, timestamps, duration, idle state, and desktop_id, but set title to null.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 1000,
          default: 50,
          description:
            'Maximum events to return in events array (default: 50, max: 1000). Does not affect summary calculation.',
        },
      },
    },
  },
];

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // Health/authentication
      case 'toggl_check_auth': {
        const me = await api.getMe();
        const workspaces = await cache.getWorkspaces();
        const maskEmail = (e?: string) => {
          if (!e) return undefined as unknown as string;
          const [user, domain] = e.split('@');
          if (!domain) return '***';
          const u = user.length <= 2 ? '*'.repeat(user.length) : `${user[0]}***${user.slice(-1)}`;
          return `${u}@${domain}`;
        };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  authenticated: true,
                  user: {
                    id: (me as any).id,
                    email: maskEmail((me as any).email),
                    fullname: (me as any).fullname,
                  },
                  workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Time tracking tools
      case 'toggl_get_time_entries': {
        await ensureCache();

        let entries: TimeEntry[];

        if (args?.period) {
          const range = getDateRange(args.period as any);
          entries = await api.getTimeEntriesForDateRange(range.start, range.end);
        } else if (args?.start_date || args?.end_date) {
          const start = args?.start_date ? parseLocalYMD(args.start_date as string) : new Date();
          start.setHours(0, 0, 0, 0);
          const end = args?.end_date ? parseInclusiveEndDate(args.end_date as string) : new Date();
          if (!args?.end_date) {
            end.setHours(0, 0, 0, 0);
            end.setDate(end.getDate() + 1);
          }
          entries = await api.getTimeEntriesForDateRange(start, end);
        } else {
          entries = await api.getTimeEntriesForToday();
        }

        // Filter by workspace/project if specified
        if (args?.workspace_id) {
          entries = entries.filter((e) => e.workspace_id === args.workspace_id);
        }
        if (args?.project_id) {
          entries = entries.filter((e) => e.project_id === args.project_id);
        }

        // Hydrate with names
        const hydrated = await cache.hydrateTimeEntries(entries);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: hydrated.length,
                  entries: hydrated,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_get_current_entry': {
        const entry = await api.getCurrentTimeEntry();

        if (!entry) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  running: false,
                  message: 'No timer currently running',
                }),
              },
            ],
          };
        }

        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([entry]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  running: true,
                  entry: hydrated[0],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_start_timer': {
        const workspaceId = await resolveWorkspaceForTool(args, 'starting a timer');

        const entry = await api.startTimer(
          workspaceId,
          args?.description as string | undefined,
          args?.project_id as number | undefined,
          args?.task_id as number | undefined,
          args?.tags as string[] | undefined
        );

        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([entry]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'Timer started',
                  entry: hydrated[0],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_stop_timer': {
        const current = await api.getCurrentTimeEntry();

        if (!current) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: 'No timer currently running',
                }),
              },
            ],
          };
        }

        const stopped = await api.stopTimer(current.workspace_id, current.id);

        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([stopped]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'Timer stopped',
                  entry: hydrated[0],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_create_entry': {
        const workspaceId = await resolveWorkspaceForTool(args, 'creating a time entry');

        let projectId = args?.project_id as number | undefined;
        const clientId = args?.client_id as number | undefined;
        if (clientId !== undefined) {
          const projects = await cache.getProjects(workspaceId);
          projectId = resolveProjectForClient(projects, clientId, projectId);
        }

        const { start, stop, duration } = buildTimeEntryInterval({
          start: args?.start,
          end: args?.end,
          duration_minutes: args?.duration_minutes,
        });

        const created = await api.createTimeEntry(workspaceId, {
          description: args?.description as string | undefined,
          project_id: projectId,
          task_id: args?.task_id as number | undefined,
          tags: args?.tags as string[] | undefined,
          billable: args?.billable as boolean | undefined,
          start,
          stop,
          duration,
        });

        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([created]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'Time entry created',
                  entry: hydrated[0],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_search_entries': {
        await ensureCache();

        // Default to roughly the last 31 days; override with period or explicit dates.
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);
        let start = new Date(todayMidnight);
        start.setDate(start.getDate() - 31);
        let end = new Date(todayMidnight);
        end.setDate(end.getDate() + 1);

        if (args?.period) {
          const range = getDateRange(args.period as any);
          start = range.start;
          end = range.end;
        } else {
          if (args?.start_date) start = parseLocalYMD(args.start_date as string);
          if (args?.end_date) end = parseInclusiveEndDate(args.end_date as string);
        }

        const entries = await api.getTimeEntriesForDateRange(start, end);
        const hydrated = await cache.hydrateTimeEntries(entries);

        const matches = filterHydratedEntries(hydrated, {
          description: args?.description as string | undefined,
          project_name: args?.project_name as string | undefined,
          client_name: args?.client_name as string | undefined,
          project_id: args?.project_id as number | undefined,
          client_id: args?.client_id as number | undefined,
          workspace_id: args?.workspace_id as number | undefined,
          tag: args?.tag as string | undefined,
          billable: args?.billable as boolean | undefined,
          start_after: args?.start_after as string | undefined,
          start_before: args?.start_before as string | undefined,
          min_duration_minutes: args?.min_duration_minutes as number | undefined,
          max_duration_minutes: args?.max_duration_minutes as number | undefined,
        });

        // Newest first so the most likely deletion target is at the top.
        matches.sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());

        const requestedLimit = typeof args?.limit === 'number' ? args.limit : 50;
        const limit = Math.min(Math.max(1, Math.floor(requestedLimit)), 1000);
        const limited = matches.slice(0, limit);

        return jsonResponse({
          count: matches.length,
          returned: limited.length,
          truncated: matches.length > limited.length,
          entries: limited,
        });
      }

      case 'toggl_delete_entry': {
        const timeEntryId = requireId(args?.time_entry_id, 'time_entry_id');

        let workspaceId = parseWorkspaceId(args?.workspace_id);
        if (workspaceId === undefined) {
          let existing: TimeEntry | undefined;
          try {
            existing = await api.getTimeEntry(timeEntryId);
          } catch (error) {
            throw new Error(
              `Time entry ${timeEntryId} was not found. Provide workspace_id, ` +
                `or use toggl_search_entries to find a valid id.`,
              { cause: error }
            );
          }
          if (!existing?.workspace_id) {
            throw new Error(
              `Time entry ${timeEntryId} was not found. Use toggl_search_entries to find a valid id.`
            );
          }
          workspaceId = existing.workspace_id;
        }

        await api.deleteTimeEntry(workspaceId, timeEntryId);

        return jsonResponse({
          success: true,
          message: 'Time entry deleted',
          time_entry_id: timeEntryId,
          workspace_id: workspaceId,
        });
      }

      // Reporting tools
      case 'toggl_daily_report': {
        await ensureCache();

        const date = args?.date ? parseLocalYMD(args.date as string) : new Date();
        date.setHours(0, 0, 0, 0);
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);

        const entries = await api.getTimeEntriesForDateRange(date, nextDay);
        const hydrated = await cache.hydrateTimeEntries(entries);

        const report = generateDailyReport(toLocalYMD(date), hydrated);

        if (args?.format === 'text') {
          return {
            content: [
              {
                type: 'text',
                text: formatReportForDisplay(report),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      }

      case 'toggl_weekly_report': {
        await ensureCache();

        const weekOffset = (args?.week_offset as number) || 0;
        const entries = await api.getTimeEntriesForWeek(weekOffset);
        const hydrated = await cache.hydrateTimeEntries(entries);

        // Calculate week boundaries in local time.
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dayOfWeek = today.getDay();
        const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        const monday = new Date(today);
        monday.setDate(diff + weekOffset * 7);
        const sunday = new Date(monday);
        sunday.setDate(sunday.getDate() + 6);

        const report = generateWeeklyReport(monday, sunday, hydrated);

        if (args?.format === 'text') {
          return {
            content: [
              {
                type: 'text',
                text: formatReportForDisplay(report),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      }

      case 'toggl_project_summary': {
        await ensureCache();

        let entries: TimeEntry[];

        if (args?.period) {
          const range = getDateRange(args.period as any);
          entries = await api.getTimeEntriesForDateRange(range.start, range.end);
        } else if (args?.start_date && args?.end_date) {
          const start = parseLocalYMD(args.start_date as string);
          const end = parseInclusiveEndDate(args.end_date as string);
          entries = await api.getTimeEntriesForDateRange(start, end);
        } else {
          // Default to current week
          entries = await api.getTimeEntriesForWeek(0);
        }

        if (args?.workspace_id) {
          entries = entries.filter((e) => e.workspace_id === args.workspace_id);
        }

        const hydrated = await cache.hydrateTimeEntries(entries);
        const byProject = groupEntriesByProject(hydrated);

        const summaries: any[] = [];
        byProject.forEach((projectEntries, projectName) => {
          summaries.push(generateProjectSummary(projectName, projectEntries));
        });

        // Sort by total hours descending
        summaries.sort((a, b) => b.total_seconds - a.total_seconds);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  project_count: summaries.length,
                  total_hours: secondsToHours(summaries.reduce((t, s) => t + s.total_seconds, 0)),
                  projects: summaries,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_workspace_summary': {
        await ensureCache();

        let entries: TimeEntry[];

        if (args?.period) {
          const range = getDateRange(args.period as any);
          entries = await api.getTimeEntriesForDateRange(range.start, range.end);
        } else if (args?.start_date && args?.end_date) {
          const start = parseLocalYMD(args.start_date as string);
          const end = parseInclusiveEndDate(args.end_date as string);
          entries = await api.getTimeEntriesForDateRange(start, end);
        } else {
          // Default to current week
          entries = await api.getTimeEntriesForWeek(0);
        }

        const hydrated = await cache.hydrateTimeEntries(entries);
        const byWorkspace = groupEntriesByWorkspace(hydrated);

        const summaries: any[] = [];
        byWorkspace.forEach((wsEntries, wsName) => {
          const wsId = wsEntries[0]?.workspace_id || 0;
          summaries.push(generateWorkspaceSummary(wsName, wsId, wsEntries));
        });

        // Sort by total hours descending
        summaries.sort((a, b) => b.total_seconds - a.total_seconds);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  workspace_count: summaries.length,
                  total_hours: secondsToHours(summaries.reduce((t, s) => t + s.total_seconds, 0)),
                  workspaces: summaries,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Management tools
      case 'toggl_list_workspaces': {
        const workspaces = await cache.getWorkspaces();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: workspaces.length,
                  workspaces: workspaces.map((ws) => ({
                    id: ws.id,
                    name: ws.name,
                    premium: ws.premium,
                    default_currency: ws.default_currency,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_list_projects': {
        const workspaceId = await resolveWorkspaceForTool(args, 'listing projects');

        const projects = await cache.getProjects(workspaceId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  workspace_id: workspaceId,
                  count: projects.length,
                  projects: projects.map((p) => ({
                    id: p.id,
                    name: p.name,
                    active: p.active,
                    billable: p.billable,
                    color: p.color,
                    client_id: p.client_id,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_list_clients': {
        const workspaceId = await resolveWorkspaceForTool(args, 'listing clients');

        const clients = await cache.getClients(workspaceId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  workspace_id: workspaceId,
                  count: clients.length,
                  clients: clients.map((c) => ({
                    id: c.id,
                    name: c.name,
                    archived: c.archived,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_create_project': {
        const workspaceId = await resolveWorkspaceForTool(args, 'creating a project');
        const name = requireName(args?.name, 'name');

        const payload = {
          ...pickDefined<CreateProjectRequest>(args ?? {}, PROJECT_FIELDS),
          name,
        } as CreateProjectRequest;

        const project = await api.createProject(workspaceId, payload);
        cache.invalidateProjects(workspaceId);

        return jsonResponse({
          success: true,
          message: 'Project created',
          project,
        });
      }

      case 'toggl_update_project': {
        const workspaceId = await resolveWorkspaceForTool(args, 'updating a project');
        const projectId = requireId(args?.project_id, 'project_id');

        const updates = pickDefined<UpdateProjectRequest>(args ?? {}, PROJECT_FIELDS);
        if (Object.keys(updates).length === 0) {
          throw new Error(
            `Provide at least one field to update. Updatable fields: ${PROJECT_FIELDS.join(', ')}.`
          );
        }

        const project = await api.updateProject(workspaceId, projectId, updates);
        cache.invalidateProjects(workspaceId);

        return jsonResponse({
          success: true,
          message: 'Project updated',
          project,
        });
      }

      case 'toggl_delete_project': {
        const workspaceId = await resolveWorkspaceForTool(args, 'deleting a project');
        const projectId = requireId(args?.project_id, 'project_id');

        await api.deleteProject(workspaceId, projectId);
        cache.invalidateProjects(workspaceId);

        return jsonResponse({
          success: true,
          message: 'Project deleted',
          project_id: projectId,
          workspace_id: workspaceId,
        });
      }

      case 'toggl_create_client': {
        const workspaceId = await resolveWorkspaceForTool(args, 'creating a client');
        const name = requireName(args?.name, 'name');

        const payload = {
          ...pickDefined<CreateClientRequest>(args ?? {}, ['name', 'notes']),
          name,
        } as CreateClientRequest;

        const client = await api.createClient(workspaceId, payload);
        cache.invalidateClients(workspaceId);

        return jsonResponse({
          success: true,
          message: 'Client created',
          client,
        });
      }

      case 'toggl_update_client': {
        const workspaceId = await resolveWorkspaceForTool(args, 'updating a client');
        const clientId = requireId(args?.client_id, 'client_id');

        const updates = pickDefined<UpdateClientRequest>(args ?? {}, CLIENT_FIELDS);
        if (Object.keys(updates).length === 0) {
          throw new Error(
            `Provide at least one field to update. Updatable fields: ${CLIENT_FIELDS.join(', ')}.`
          );
        }

        const client = await api.updateClient(workspaceId, clientId, updates);
        cache.invalidateClients(workspaceId);

        return jsonResponse({
          success: true,
          message: 'Client updated',
          client,
        });
      }

      case 'toggl_delete_client': {
        const workspaceId = await resolveWorkspaceForTool(args, 'deleting a client');
        const clientId = requireId(args?.client_id, 'client_id');

        await api.deleteClient(workspaceId, clientId);
        cache.invalidateClients(workspaceId);

        return jsonResponse({
          success: true,
          message: 'Client deleted',
          client_id: clientId,
          workspace_id: workspaceId,
        });
      }

      // Team / admin tools
      case 'toggl_list_users': {
        const workspaceId = await resolveWorkspaceForTool(args, 'listing workspace users');
        const users = await api.getWorkspaceUsers(workspaceId);

        // Passed through exactly as Toggl returns them: this endpoint's response
        // schema is not published, so reshaping it here risks dropping or
        // mislabeling fields. Interpret the objects as-is.
        return jsonResponse({
          workspace_id: workspaceId,
          count: users.length,
          note: 'users[] is Toggl\'s raw response, unmodified. The Toggl user id (usually "id" here) is what time entries are keyed by — pass it as user_ids to toggl_team_entries / toggl_team_summary.',
          users,
        });
      }

      case 'toggl_list_org_users': {
        const organizationId = await resolveOrganizationForTool(
          args,
          'listing organization users'
        );

        const users = await api.getOrganizationUsers(organizationId, {
          filter: args?.filter as string | undefined,
          active_status: args?.active_status as string | undefined,
          only_admins: args?.only_admins as boolean | undefined,
        });

        // Raw passthrough — this endpoint's response schema is not published.
        return jsonResponse({
          organization_id: organizationId,
          count: users.length,
          note: "users[] is Toggl's raw response, unmodified. CAUTION: these objects carry two different ids — the organization-user id (\"id\") and the Toggl user id (\"user_id\"). Only user_id matches time entries, so pass user_id (not id) as user_ids to toggl_team_entries / toggl_team_summary.",
          users,
        });
      }

      case 'toggl_team_entries': {
        const workspaceId = await resolveWorkspaceForTool(args, 'reading team time entries');
        const { rows, window, truncated, users, projects, clients } = await fetchTeamReport(
          workspaceId,
          args
        );

        const requestedLimit = typeof args?.limit === 'number' ? args.limit : 100;
        const limit = Math.min(Math.max(1, Math.floor(requestedLimit)), 1000);
        const limited = rows.slice(0, limit);

        // Rows are returned exactly as the Reports API produced them — its response
        // schema is not published, so reshaping risks dropping fields. Reference
        // lookups are supplied alongside so ids can be resolved to names.
        return jsonResponse({
          workspace_id: workspaceId,
          start_date: window.start_date,
          end_date: window.end_date,
          row_count: rows.length,
          returned: limited.length,
          truncated: truncated || rows.length > limited.length,
          note: "rows[] is the Toggl Reports API response, unmodified. A row typically groups several time entries under a nested array. Use the lookups below to resolve user_id / project_id / client_id to names. Durations are in seconds.",
          lookups: { users, projects, clients },
          rows: limited,
        });
      }

      case 'toggl_team_summary': {
        const workspaceId = await resolveWorkspaceForTool(args, 'summarizing team time');
        const { rows, window, truncated, users: workspaceUsers } = await fetchTeamReport(
          workspaceId,
          args
        );

        // Unlike the other team tools this cannot be a raw passthrough: totalling
        // hours per user requires knowing which field holds the duration.
        const userNames = new Map(workspaceUsers.map((user) => [user.id, user.name]));
        const entries = normalizeReportRows(rows, userNames);
        const users = summarizeByUser(entries);
        const totalSeconds = users.reduce((sum, user) => sum + user.total_seconds, 0);

        // If Toggl returned rows but every duration came out zero, the field names
        // this aggregation assumes are wrong. Say so instead of reporting "0 hours"
        // as though the team logged nothing.
        const schemaWarning =
          rows.length > 0 && totalSeconds === 0
            ? 'Toggl returned rows but no durations could be read from them, so these totals are unreliable. The report response shape may differ from what this aggregation expects. Use toggl_team_entries to inspect the raw rows.'
            : undefined;

        return jsonResponse({
          workspace_id: workspaceId,
          start_date: window.start_date,
          end_date: window.end_date,
          user_count: users.length,
          total_hours: secondsToHours(totalSeconds),
          total_seconds: totalSeconds,
          truncated,
          ...(schemaWarning ? { schema_warning: schemaWarning } : {}),
          users,
        });
      }

      // Cache management
      case 'toggl_warm_cache': {
        const workspaceId = await resolveWorkspaceForTool(args, 'warming the cache');
        await cache.warmCache(workspaceId);
        cacheWarmed = true;

        const stats = cache.getStats();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'Cache warmed successfully',
                  stats,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_cache_stats': {
        const stats = cache.getStats();
        const hitRate =
          stats.hits + stats.misses > 0
            ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100)
            : 0;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ...stats,
                  hit_rate: `${hitRate}%`,
                  cache_warmed: cacheWarmed,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'toggl_clear_cache': {
        cache.clearCache();
        cacheWarmed = false;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Cache cleared successfully',
              }),
            },
          ],
        };
      }

      case 'toggl_get_timeline': {
        localDateRangeFromArgs(args);

        let allEvents: TimelineEvent[];
        try {
          allEvents = await api.getTimeline();
        } catch (error) {
          if (error instanceof TimelineNotEnabledError) {
            return jsonResponse({
              enabled: false,
              total_events: 0,
              returned_events: 0,
              truncated: false,
              total_seconds: 0,
              total_hours: 0,
              summary: {},
              events: [],
              message:
                'Toggl Desktop timeline is not enabled yet. Open the Toggl Track Desktop app for Mac, enable timeline/activity tracking and sync, then retry this tool after the app has uploaded activity data.',
            });
          }
          throw error;
        }

        return jsonResponse(buildTimelineResponse(allEvents, args));
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: unknown) {
    return jsonResponse(errorPayload(error));
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Toggl MCP server running');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
