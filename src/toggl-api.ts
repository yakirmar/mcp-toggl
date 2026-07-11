import fetch from 'node-fetch';
import { toLocalYMD } from './utils.js';
import { extractOrganizationUsers } from './organization.js';
import type {
  Workspace,
  Project,
  Client,
  Task,
  User,
  Tag,
  TimeEntry,
  TimeEntriesRequest,
  CreateTimeEntryRequest,
  UpdateTimeEntryRequest,
  CreateProjectRequest,
  UpdateProjectRequest,
  CreateClientRequest,
  UpdateClientRequest,
  WorkspaceUser,
  OrganizationUser,
  OrganizationUsersParams,
  ReportSearchParams,
  ReportRow,
  TimelineEvent,
} from './types.js';

export class TimelineNotEnabledError extends Error {
  constructor() {
    super('Timeline is not enabled');
    this.name = 'TimelineNotEnabledError';
  }
}

export class TogglAPIError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retry_after_seconds?: number;
  readonly tip?: string;
  readonly noRetry = true;

  constructor({
    status,
    code,
    message,
    retryAfterSeconds,
    tip,
  }: {
    status: number;
    code: string;
    message: string;
    retryAfterSeconds?: number;
    tip?: string;
  }) {
    super(message);
    this.name = 'TogglAPIError';
    this.status = status;
    this.code = code;
    this.retry_after_seconds = retryAfterSeconds;
    this.tip = tip;
  }
}

const MAX_AUTO_RETRY_MS = 30_000;

export class TogglAPI {
  private baseUrl = 'https://api.track.toggl.com/api/v9';
  private timelineBaseUrl = 'https://track.toggl.com/api/v9';
  private reportsBaseUrl = 'https://api.track.toggl.com/reports/api/v3';
  private headers: Record<string, string>;

  // Reports API paging. The cap bounds a runaway pull of a large workspace;
  // callers are told when it bites via `truncated`.
  private static readonly REPORT_PAGE_SIZE = 200;
  private static readonly REPORT_MAX_PAGES = 25;

  constructor(apiKey: string) {
    // Basic auth: API key as username, 'api_token' as password
    const key = apiKey.trim();
    const auth = Buffer.from(`${key}:api_token`).toString('base64');
    this.headers = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mcp-toggl/1.0.0 (+https://verygoodplugins.com)',
    };
  }

  // Generic API request against the core v9 base URL.
  private async request<T>(method: string, endpoint: string, body?: any, retries = 3): Promise<T> {
    const { data } = await this.requestAbsolute<T>(
      method,
      `${this.baseUrl}${endpoint}`,
      body,
      retries
    );
    return data;
  }

  // Same transport (auth, retry, 429/402 handling) but against a caller-supplied
  // URL, and it surfaces response headers — the Reports API lives on a different
  // base URL and paginates via X-Next-Row-Number.
  private async requestAbsolute<T>(
    method: string,
    url: string,
    body?: any,
    retries = 3
  ): Promise<{ data: T; headers: Record<string, string | null> }> {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          method,
          headers: this.headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        // Handle rate limiting without sleeping for multi-minute quota resets.
        if (response.status === 429) {
          const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'));
          const delay = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : (i + 1) * 2000;
          if (delay <= MAX_AUTO_RETRY_MS && i < retries - 1) {
            // Log to stderr so we don't pollute MCP stdio
            console.error(`Rate limited. Retrying after ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          throw new TogglAPIError({
            status: response.status,
            code: 'RATE_LIMITED',
            message: 'Toggl API rate limit reached.',
            retryAfterSeconds,
            tip: 'Retry after the indicated delay, or use cached/list summary tools to reduce repeated Toggl API calls.',
          });
        }

        if (!response.ok) {
          const text = await response.text();
          if (response.status === 402) {
            const retryAfterSeconds = parseQuotaResetSeconds(text);
            throw new TogglAPIError({
              status: response.status,
              code: 'TOGGL_QUOTA_LIMIT',
              message: `Toggl API quota limit reached.${retryAfterSeconds !== undefined ? ` Quota resets in ${retryAfterSeconds} seconds.` : ''}`,
              retryAfterSeconds,
              tip: 'Wait for the Toggl quota window to reset. Cache-backed list tools avoid repeated project/client fetches after they are warmed.',
            });
          }

          const isAuth = response.status === 401 || response.status === 403;
          const message = isAuth
            ? `Authentication failed (${response.status}). ` +
              `Verify TOGGL_API_KEY is correct, has no leading/trailing spaces, and is the Toggl Track API token. ` +
              `Server response: ${text}`
            : `Toggl API error (${response.status}): ${text}`;
          const err = new Error(message);
          // 4xx client errors won't succeed on retry (incl. 401/403); 5xx and network errors do retry.
          if (response.status >= 400 && response.status < 500) {
            Object.assign(err, { noRetry: true });
          }
          throw err;
        }

        const headers = {
          'x-next-row-number': response.headers.get('X-Next-Row-Number'),
          'x-next-id': response.headers.get('X-Next-ID'),
        };

        // Handle 204 No Content
        if (response.status === 204) {
          return { data: {} as T, headers };
        }

        return { data: (await response.json()) as T, headers };
      } catch (error: any) {
        if (error?.noRetry || i === retries - 1) throw error;
        // Exponential backoff for transient/network errors
        await new Promise((resolve) => setTimeout(resolve, (i + 1) * 1000));
      }
    }

    throw new Error('Max retries reached');
  }

  // User methods
  async getMe(): Promise<User> {
    return this.request<User>('GET', '/me');
  }

  async getUser(_userId: number): Promise<User> {
    // Note: This might require admin permissions
    return this.request<User>('GET', `/me`);
  }

  // Workspace methods
  async getWorkspaces(): Promise<Workspace[]> {
    return this.request<Workspace[]>('GET', '/workspaces');
  }

  async getWorkspace(workspaceId: number): Promise<Workspace> {
    return this.request<Workspace>('GET', `/workspaces/${workspaceId}`);
  }

  // Toggl v9 list endpoints paginate by `page`/`per_page` (1-indexed, sorted by name).
  // Without explicit pagination the API returns only the first page and silently drops
  // the tail, so any project/client past it fails to resolve and shows as "Project <id>".
  private static readonly PAGE_SIZE = 200;
  private static readonly MAX_PAGES = 100;

  private async requestAllPages<T extends { id?: number }>(endpoint: string): Promise<T[]> {
    const sep = endpoint.includes('?') ? '&' : '?';
    const all: T[] = [];
    let prevFirstId: number | undefined;

    for (let page = 1; page <= TogglAPI.MAX_PAGES; page++) {
      const batch = await this.request<T[]>(
        'GET',
        `${endpoint}${sep}per_page=${TogglAPI.PAGE_SIZE}&page=${page}`
      );
      if (!Array.isArray(batch) || batch.length === 0) break;

      // Guard against endpoints that ignore `page` and keep returning the same window,
      // which would otherwise loop until MAX_PAGES.
      const firstId = batch[0]?.id;
      if (page > 1 && firstId !== undefined && firstId === prevFirstId) break;
      prevFirstId = firstId;

      all.push(...batch);
      if (batch.length < TogglAPI.PAGE_SIZE) break;
    }

    return all;
  }

  // Project methods
  async getProjects(workspaceId: number): Promise<Project[]> {
    return this.requestAllPages<Project>(`/workspaces/${workspaceId}/projects`);
  }

  async getProject(projectId: number): Promise<Project> {
    // First, we need to find which workspace this project belongs to
    // This is a limitation of Toggl API v9 - no direct project endpoint
    const workspaces = await this.getWorkspaces();
    for (const workspace of workspaces) {
      const projects = await this.getProjects(workspace.id);
      const project = projects.find((p) => p.id === projectId);
      if (project) return project;
    }
    throw new Error(`Project ${projectId} not found`);
  }

  async createProject(workspaceId: number, project: CreateProjectRequest): Promise<Project> {
    return this.request<Project>('POST', `/workspaces/${workspaceId}/projects`, project);
  }

  async updateProject(
    workspaceId: number,
    projectId: number,
    updates: UpdateProjectRequest
  ): Promise<Project> {
    return this.request<Project>(
      'PUT',
      `/workspaces/${workspaceId}/projects/${projectId}`,
      updates
    );
  }

  async deleteProject(workspaceId: number, projectId: number): Promise<void> {
    await this.request<void>('DELETE', `/workspaces/${workspaceId}/projects/${projectId}`);
  }

  // Client methods
  async getClients(workspaceId: number): Promise<Client[]> {
    return this.requestAllPages<Client>(`/workspaces/${workspaceId}/clients`);
  }

  async createClient(workspaceId: number, client: CreateClientRequest): Promise<Client> {
    return this.request<Client>('POST', `/workspaces/${workspaceId}/clients`, client);
  }

  async updateClient(
    workspaceId: number,
    clientId: number,
    updates: UpdateClientRequest
  ): Promise<Client> {
    return this.request<Client>('PUT', `/workspaces/${workspaceId}/clients/${clientId}`, updates);
  }

  async deleteClient(workspaceId: number, clientId: number): Promise<void> {
    await this.request<void>('DELETE', `/workspaces/${workspaceId}/clients/${clientId}`);
  }

  async getClient(clientId: number): Promise<Client> {
    // Similar to projects, need to find workspace first
    const workspaces = await this.getWorkspaces();
    for (const workspace of workspaces) {
      try {
        const clients = await this.getClients(workspace.id);
        const client = clients.find((c) => c.id === clientId);
        if (client) return client;
      } catch (_error) {
        // Workspace might not have clients
        continue;
      }
    }
    throw new Error(`Client ${clientId} not found`);
  }

  // Task methods
  async getTasks(workspaceId: number, projectId: number): Promise<Task[]> {
    return this.request<Task[]>('GET', `/workspaces/${workspaceId}/projects/${projectId}/tasks`);
  }

  async getTask(workspaceId: number, projectId: number, taskId: number): Promise<Task> {
    return this.request<Task>(
      'GET',
      `/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`
    );
  }

  // Tag methods
  async getTags(workspaceId: number): Promise<Tag[]> {
    return this.request<Tag[]>('GET', `/workspaces/${workspaceId}/tags`);
  }

  async getTag(workspaceId: number, tagId: number): Promise<Tag> {
    return this.request<Tag>('GET', `/workspaces/${workspaceId}/tags/${tagId}`);
  }

  // Time entry methods
  async getTimeEntries(params?: TimeEntriesRequest): Promise<TimeEntry[]> {
    let endpoint = '/me/time_entries';

    if (params) {
      const queryParams = new URLSearchParams();
      if (params.start_date) queryParams.append('start_date', params.start_date);
      if (params.end_date) queryParams.append('end_date', params.end_date);
      if (params.since) queryParams.append('since', params.since.toString());
      if (params.before) queryParams.append('before', params.before.toString());
      if (params.meta !== undefined) queryParams.append('meta', params.meta.toString());

      const query = queryParams.toString();
      if (query) endpoint += `?${query}`;
    }

    return this.request<TimeEntry[]>('GET', endpoint);
  }

  async getCurrentTimeEntry(): Promise<TimeEntry | null> {
    const result = await this.request<TimeEntry | null>('GET', '/me/time_entries/current');
    return result;
  }

  async getTimeEntry(timeEntryId: number): Promise<TimeEntry> {
    return this.request<TimeEntry>('GET', `/me/time_entries/${timeEntryId}`);
  }

  async createTimeEntry(
    workspaceId: number,
    entry: Partial<CreateTimeEntryRequest>
  ): Promise<TimeEntry> {
    const payload: CreateTimeEntryRequest = {
      workspace_id: workspaceId,
      created_with: 'mcp-toggl',
      start: entry.start || new Date().toISOString(),
      ...entry,
    };

    return this.request<TimeEntry>('POST', `/workspaces/${workspaceId}/time_entries`, payload);
  }

  async updateTimeEntry(
    workspaceId: number,
    timeEntryId: number,
    updates: UpdateTimeEntryRequest
  ): Promise<TimeEntry> {
    return this.request<TimeEntry>(
      'PUT',
      `/workspaces/${workspaceId}/time_entries/${timeEntryId}`,
      updates
    );
  }

  async deleteTimeEntry(workspaceId: number, timeEntryId: number): Promise<void> {
    await this.request<void>('DELETE', `/workspaces/${workspaceId}/time_entries/${timeEntryId}`);
  }

  async startTimer(
    workspaceId: number,
    description?: string,
    projectId?: number,
    taskId?: number,
    tags?: string[]
  ): Promise<TimeEntry> {
    const entry: Partial<CreateTimeEntryRequest> = {
      description,
      project_id: projectId,
      task_id: taskId,
      tags,
      start: new Date().toISOString(),
      duration: -1, // Negative duration indicates running timer
    };

    return this.createTimeEntry(workspaceId, entry);
  }

  async stopTimer(workspaceId: number, timeEntryId: number): Promise<TimeEntry> {
    const now = new Date().toISOString();
    return this.updateTimeEntry(workspaceId, timeEntryId, { stop: now });
  }

  // Bulk operations for efficiency. endDate is exclusive per Toggl Track v9.
  async getTimeEntriesForDateRange(startDate: Date, endDate: Date): Promise<TimeEntry[]> {
    const params: TimeEntriesRequest = {
      start_date: toLocalYMD(startDate),
      end_date: toLocalYMD(endDate),
    };

    return this.getTimeEntries(params);
  }

  async getTimeEntriesForToday(): Promise<TimeEntry[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return this.getTimeEntriesForDateRange(today, tomorrow);
  }

  async getTimeEntriesForWeek(weekOffset = 0): Promise<TimeEntry[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay();
    const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust for Sunday

    const monday = new Date(today);
    monday.setDate(diff + weekOffset * 7);

    const nextMonday = new Date(monday);
    nextMonday.setDate(nextMonday.getDate() + 7);

    return this.getTimeEntriesForDateRange(monday, nextMonday);
  }

  async getTimeEntriesForMonth(monthOffset = 0): Promise<TimeEntry[]> {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + monthOffset;

    const firstDay = new Date(year, month, 1);
    const firstDayNextMonth = new Date(year, month + 1, 1);

    return this.getTimeEntriesForDateRange(firstDay, firstDayNextMonth);
  }

  // Organization methods. Require organization admin rights.
  // Members of an organization, across all its workspaces. Paginated via
  // page/per_page; the envelope is not documented, so extraction is defensive.
  async getOrganizationUsers(
    organizationId: number,
    params: OrganizationUsersParams = {}
  ): Promise<OrganizationUser[]> {
    const perPage = params.per_page ?? TogglAPI.PAGE_SIZE;
    const all: OrganizationUser[] = [];

    for (let page = params.page ?? 1; page <= TogglAPI.MAX_PAGES; page++) {
      const query = new URLSearchParams();
      query.set('per_page', String(perPage));
      query.set('page', String(page));
      if (params.filter) query.set('filter', params.filter);
      if (params.active_status) query.set('active_status', params.active_status);
      if (params.only_admins !== undefined) query.set('only_admins', String(params.only_admins));
      if (params.sort_dir) query.set('sort_dir', params.sort_dir);

      const payload = await this.request<unknown>(
        'GET',
        `/organizations/${organizationId}/users?${query.toString()}`
      );

      const batch = extractOrganizationUsers(payload);
      if (batch.length === 0) break;

      all.push(...batch);
      if (batch.length < perPage) break;

      // A single explicit page was requested — do not keep walking.
      if (params.page !== undefined) break;
    }

    return all;
  }

  // Workspace members. Requires admin rights on the workspace; non-admin tokens
  // typically get a 403 rather than a filtered list.
  async getWorkspaceUsers(workspaceId: number): Promise<WorkspaceUser[]> {
    const users = await this.request<WorkspaceUser[]>('GET', `/workspaces/${workspaceId}/users`);
    return Array.isArray(users) ? users : [];
  }

  // Detailed report across ALL users in the workspace that the token can see.
  // This is the only way to read other users' entries — /me/time_entries is
  // self-scoped by definition. Pages via the X-Next-Row-Number response header.
  async searchDetailedReport(
    workspaceId: number,
    params: ReportSearchParams = {}
  ): Promise<{ rows: ReportRow[]; truncated: boolean }> {
    const url = `${this.reportsBaseUrl}/workspace/${workspaceId}/search/time_entries`;
    const pageSize = params.page_size ?? TogglAPI.REPORT_PAGE_SIZE;

    const rows: ReportRow[] = [];
    let firstRowNumber = params.first_row_number;

    for (let page = 0; page < TogglAPI.REPORT_MAX_PAGES; page++) {
      const body: ReportSearchParams = {
        ...params,
        page_size: pageSize,
        ...(firstRowNumber !== undefined ? { first_row_number: firstRowNumber } : {}),
      };

      const { data, headers } = await this.requestAbsolute<ReportRow[]>('POST', url, body);
      if (!Array.isArray(data) || data.length === 0) break;

      rows.push(...data);

      const next = headers['x-next-row-number'];
      const nextRowNumber = next ? Number.parseInt(next, 10) : NaN;
      if (!Number.isFinite(nextRowNumber) || nextRowNumber <= 0) break;
      // Guard against an endpoint that keeps handing back the same cursor.
      if (firstRowNumber !== undefined && nextRowNumber === firstRowNumber) break;
      firstRowNumber = nextRowNumber;
    }

    // Signal when we stopped at the page cap rather than at the end of the data.
    const truncated = rows.length >= TogglAPI.REPORT_MAX_PAGES * pageSize;
    return { rows, truncated };
  }

  async getTimeline(): Promise<TimelineEvent[]> {
    const url = `${this.timelineBaseUrl}/timeline`;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: this.headers,
        });

        if (response.status === 429) {
          const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'));
          const delay =
            retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : (attempt + 1) * 2000;
          if (delay <= MAX_AUTO_RETRY_MS && attempt < maxRetries - 1) {
            console.error(`Timeline rate limited. Retrying after ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          throw new TogglAPIError({
            status: response.status,
            code: 'RATE_LIMITED',
            message: 'Toggl timeline API rate limit reached.',
            retryAfterSeconds,
            tip: 'Retry after the indicated delay. For Claude Desktop charts, request summary-only timeline output with include_events: false.',
          });
        }

        const text = await response.text();

        if (!response.ok) {
          if (response.status === 400 && parseTimelineError(text) === 'Timeline is not enabled') {
            throw new TimelineNotEnabledError();
          }

          const isAuth = response.status === 401 || response.status === 403;
          const message = isAuth
            ? `Timeline authentication failed (${response.status}). Verify TOGGL_API_KEY is correct. Server response: ${text}`
            : `Timeline API error (${response.status}): ${text}`;
          const err = new Error(message);
          if (response.status >= 400 && response.status < 500) {
            Object.assign(err, { noRetry: true });
          }
          throw err;
        }

        const data = JSON.parse(text) as unknown;
        if (!Array.isArray(data)) {
          throw new Error('Timeline API returned invalid response format');
        }

        return data.filter(isTimelineEvent);
      } catch (error: any) {
        if (
          error instanceof TimelineNotEnabledError ||
          error?.noRetry ||
          attempt === maxRetries - 1
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
      }
    }

    throw new Error('Max retries reached for timeline');
  }
}

function parseTimelineError(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'string' ? parsed : text;
  } catch (_error) {
    return text;
  }
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;

  const deltaSeconds = Number.parseInt(value, 10);
  if (Number.isFinite(deltaSeconds)) return Math.max(0, deltaSeconds);

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}

function parseQuotaResetSeconds(text: string): number | undefined {
  const match = /quota will reset in (\d+) seconds/i.exec(text);
  if (!match) return undefined;
  const seconds = Number.parseInt(match[1]!, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function isTimelineEvent(value: unknown): value is TimelineEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;

  return (
    typeof event.id === 'number' &&
    typeof event.start_time === 'number' &&
    (typeof event.end_time === 'number' || event.end_time === null) &&
    typeof event.desktop_id === 'string' &&
    typeof event.idle === 'boolean' &&
    (typeof event.filename === 'string' || event.filename === null) &&
    (typeof event.title === 'string' || event.title === null)
  );
}
