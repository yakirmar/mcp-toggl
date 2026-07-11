import { afterEach, describe, expect, it, vi } from 'vitest';
import { TogglAPI, TogglAPIError } from '../src/toggl-api.js';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('node-fetch', () => ({
  default: fetchMock,
}));

function response({
  status,
  text = '',
  json,
  retryAfter,
}: {
  status: number;
  text?: string;
  json?: unknown;
  retryAfter?: string;
}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: vi.fn((name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null)),
    },
    text: vi.fn(async () => text),
    json: vi.fn(async () => json),
  };
}

describe('toggl api errors', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('parses Toggl quota reset seconds from 402 responses', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 402,
        text: 'You have hit your hourly limit for API calls. The quota will reset in 133 seconds.',
      })
    );

    const api = new TogglAPI('token');
    await expect(api.getWorkspaces()).rejects.toMatchObject({
      code: 'TOGGL_QUOTA_LIMIT',
      status: 402,
      retry_after_seconds: 133,
    });
    await expect(api.getWorkspaces()).rejects.toBeInstanceOf(TogglAPIError);
  });

  it('returns structured rate limit errors instead of sleeping for long retry windows', async () => {
    fetchMock.mockResolvedValue(response({ status: 429, retryAfter: '60' }));

    const api = new TogglAPI('token');
    await expect(api.getWorkspaces()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retry_after_seconds: 60,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createTimeEntry', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('POSTs a completed entry with created_with and the provided interval', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ status: 200, json: { id: 55, workspace_id: 42, project_id: 7 } })
    );

    const api = new TogglAPI('token');
    const entry = await api.createTimeEntry(42, {
      description: 'Focus block',
      project_id: 7,
      tags: ['deep-work'],
      billable: true,
      start: '2026-07-11T09:00:00.000Z',
      stop: '2026-07-11T10:30:00.000Z',
      duration: 5400,
    });

    expect(entry).toMatchObject({ id: 55, workspace_id: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain('/workspaces/42/time_entries');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      workspace_id: 42,
      created_with: 'mcp-toggl',
      description: 'Focus block',
      project_id: 7,
      tags: ['deep-work'],
      billable: true,
      start: '2026-07-11T09:00:00.000Z',
      stop: '2026-07-11T10:30:00.000Z',
      duration: 5400,
    });
  });

  it('defaults start to now when the caller omits it', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200, json: { id: 1, workspace_id: 42 } }));

    const api = new TogglAPI('token');
    await api.createTimeEntry(42, { description: 'No explicit start' });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(typeof body.start).toBe('string');
    // A valid ISO 8601 timestamp was filled in.
    expect(Number.isNaN(Date.parse(body.start as string))).toBe(false);
  });
});

describe('deleteTimeEntry', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('issues a DELETE to the workspace-scoped entry endpoint', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200 }));

    const api = new TogglAPI('token');
    await expect(api.deleteTimeEntry(42, 999)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(url).toContain('/workspaces/42/time_entries/999');
    expect(init.method).toBe('DELETE');
  });

  it('treats a 204 No Content response as success', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 204 }));

    const api = new TogglAPI('token');
    await expect(api.deleteTimeEntry(42, 999)).resolves.toBeUndefined();
  });
});

describe('list endpoint pagination', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  const page = (count: number, startId: number) =>
    Array.from({ length: count }, (_, i) => ({ id: startId + i, name: `item-${startId + i}` }));

  it('fetches every page of projects until a short page is returned', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: 200, json: page(200, 1) }))
      .mockResolvedValueOnce(response({ status: 200, json: page(7, 1000) }));

    const api = new TogglAPI('token');
    const projects = await api.getProjects(2154504);

    expect(projects).toHaveLength(207);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('/workspaces/2154504/projects?per_page=200&page=1');
    expect(urls[1]).toContain('/workspaces/2154504/projects?per_page=200&page=2');
  });

  it('makes a single request when the first page is shorter than the page size', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200, json: page(3, 1) }));

    const api = new TogglAPI('token');
    const clients = await api.getClients(2154504);

    expect(clients).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/workspaces/2154504/clients?per_page=200&page=1');
  });

  it('stops instead of looping when the endpoint ignores the page param', async () => {
    // Same full page returned regardless of page number — must not loop forever.
    fetchMock.mockResolvedValue(response({ status: 200, json: page(200, 1) }));

    const api = new TogglAPI('token');
    const projects = await api.getProjects(2154504);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(projects).toHaveLength(200);
  });
});

describe('project and client CRUD requests', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  const callOf = (index = 0) =>
    fetchMock.mock.calls[index] as [string, { method: string; body?: string }];

  it('POSTs a new project to the workspace projects endpoint', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200, json: { id: 7, name: 'Website' } }));

    const api = new TogglAPI('token');
    const project = await api.createProject(42, {
      name: 'Website',
      client_id: 500,
      billable: true,
      color: '#0b83d9',
    });

    expect(project).toMatchObject({ id: 7 });
    const [url, init] = callOf();
    expect(url).toContain('/workspaces/42/projects');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body!)).toEqual({
      name: 'Website',
      client_id: 500,
      billable: true,
      color: '#0b83d9',
    });
  });

  it('PUTs a partial project update to the project endpoint', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200, json: { id: 7, active: false } }));

    const api = new TogglAPI('token');
    await api.updateProject(42, 7, { active: false });

    const [url, init] = callOf();
    expect(url).toContain('/workspaces/42/projects/7');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body!)).toEqual({ active: false });
  });

  it('DELETEs a project', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200 }));

    const api = new TogglAPI('token');
    await expect(api.deleteProject(42, 7)).resolves.toBeUndefined();

    const [url, init] = callOf();
    expect(url).toContain('/workspaces/42/projects/7');
    expect(init.method).toBe('DELETE');
  });

  it('POSTs a new client to the workspace clients endpoint', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200, json: { id: 500, name: 'Globex' } }));

    const api = new TogglAPI('token');
    const client = await api.createClient(42, { name: 'Globex', notes: 'Retainer' });

    expect(client).toMatchObject({ id: 500 });
    const [url, init] = callOf();
    expect(url).toContain('/workspaces/42/clients');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body!)).toEqual({ name: 'Globex', notes: 'Retainer' });
  });

  it('PUTs a partial client update and DELETEs a client', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: 200, json: { id: 500, archived: true } }))
      .mockResolvedValueOnce(response({ status: 204 }));

    const api = new TogglAPI('token');
    await api.updateClient(42, 500, { archived: true });
    await expect(api.deleteClient(42, 500)).resolves.toBeUndefined();

    const [updateUrl, updateInit] = callOf(0);
    expect(updateUrl).toContain('/workspaces/42/clients/500');
    expect(updateInit.method).toBe('PUT');
    expect(JSON.parse(updateInit.body!)).toEqual({ archived: true });

    const [deleteUrl, deleteInit] = callOf(1);
    expect(deleteUrl).toContain('/workspaces/42/clients/500');
    expect(deleteInit.method).toBe('DELETE');
  });
});
