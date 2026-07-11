import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const entryPoint = resolve('dist/index.js');

describe.skipIf(!existsSync(entryPoint))('stdio smoke checks', () => {
  it('keeps CLI metadata off stdout', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [entryPoint, '--version']);

    expect(stdout).toBe('');
    expect(stderr).toContain('mcp-toggl version');
  });

  it('reports missing configuration on stderr before opening stdio transport', async () => {
    let result:
      | {
          code?: number;
          stdout?: string;
          stderr?: string;
        }
      | undefined;

    try {
      await execFileAsync(process.execPath, [entryPoint], {
        env: {
          ...process.env,
          TOGGL_API_KEY: '',
          TOGGL_API_TOKEN: '',
          TOGGL_TOKEN: '',
        },
      });
    } catch (error) {
      result = error as typeof result;
    }

    expect(result?.code).toBe(1);
    expect(result?.stdout).toBe('');
    expect(result?.stderr).toContain('Missing required environment variable');
  });

  it('exposes timeline schema bounds and sanitized tool errors', async () => {
    const client = new Client({ name: 'mcp-toggl-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPoint],
      env: {
        ...process.env,
        TOGGL_API_KEY: 'dummy-token',
        TOGGL_API_TOKEN: '',
        TOGGL_TOKEN: '',
      },
    });

    await client.connect(transport);

    try {
      const tools = await client.listTools();
      const timelineTool = tools.tools.find((tool) => tool.name === 'toggl_get_timeline');
      const properties = timelineTool?.inputSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(properties?.limit).toMatchObject({
        minimum: 1,
        maximum: 1000,
        default: 50,
      });
      expect(properties?.redact_titles).toMatchObject({
        type: 'boolean',
        default: false,
      });

      const result = await client.callTool({
        name: 'toggl_get_timeline',
        arguments: { start_date: '2026-02-30' },
      });
      const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
      const serialized = JSON.stringify(payload);

      expect(payload.error).toBe(true);
      expect(payload.message).toContain('Invalid calendar date');
      expect(payload).not.toHaveProperty('details');
      expect(serialized).not.toContain('/Users/');
      expect(serialized).not.toContain('dist/index.js');
      expect(serialized).not.toContain('at ');
    } finally {
      await client.close();
    }
  });
});

describe.skipIf(!existsSync(entryPoint))('toggl_create_entry over stdio', () => {
  async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'mcp-toggl-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPoint],
      env: {
        ...process.env,
        TOGGL_API_KEY: 'dummy-token',
        TOGGL_API_TOKEN: '',
        TOGGL_TOKEN: '',
      },
    });

    await client.connect(transport);
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  }

  async function callCreateEntry(
    client: Client,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name: 'toggl_create_entry', arguments: args });
    const content = result.content as Array<{ text?: string }> | undefined;
    return JSON.parse(content?.[0]?.text ?? '{}') as Record<string, unknown>;
  }

  it('registers the tool with start required and project/client/duration inputs', async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      const tool = tools.tools.find((t) => t.name === 'toggl_create_entry');

      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toEqual(['start']);

      const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;
      for (const key of [
        'description',
        'workspace_id',
        'project_id',
        'client_id',
        'task_id',
        'tags',
        'billable',
        'start',
        'end',
        'duration_minutes',
      ]) {
        expect(properties).toHaveProperty(key);
      }
    });
  });

  it('rejects supplying both end and duration_minutes', async () => {
    await withClient(async (client) => {
      // Explicit workspace_id keeps resolution offline so only interval validation runs.
      const payload = await callCreateEntry(client, {
        workspace_id: 123,
        start: '2026-07-11T09:00:00Z',
        end: '2026-07-11T10:00:00Z',
        duration_minutes: 60,
      });

      expect(payload.error).toBe(true);
      expect(payload.message).toContain('exactly one of end or duration_minutes');
    });
  });

  it('rejects supplying neither end nor duration_minutes', async () => {
    await withClient(async (client) => {
      const payload = await callCreateEntry(client, {
        workspace_id: 123,
        start: '2026-07-11T09:00:00Z',
      });

      expect(payload.error).toBe(true);
      expect(payload.message).toContain('exactly one of end or duration_minutes');
    });
  });

  it('rejects an invalid start datetime', async () => {
    await withClient(async (client) => {
      const payload = await callCreateEntry(client, {
        workspace_id: 123,
        start: 'not-a-datetime',
        duration_minutes: 60,
      });

      expect(payload.error).toBe(true);
      expect(payload.message).toContain('Invalid start');
    });
  });

  it('rejects an end that precedes start without leaking internals', async () => {
    await withClient(async (client) => {
      const payload = await callCreateEntry(client, {
        workspace_id: 123,
        start: '2026-07-11T10:00:00Z',
        end: '2026-07-11T09:00:00Z',
      });

      expect(payload.error).toBe(true);
      expect(payload.message).toContain('end must be after start');

      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('/Users/');
      expect(serialized).not.toContain('dist/index.js');
      expect(serialized).not.toContain('at ');
    });
  });
});

describe.skipIf(!existsSync(entryPoint))('search and delete tools over stdio', () => {
  async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'mcp-toggl-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPoint],
      env: {
        ...process.env,
        TOGGL_API_KEY: 'dummy-token',
        TOGGL_API_TOKEN: '',
        TOGGL_TOKEN: '',
      },
    });

    await client.connect(transport);
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  }

  it('registers toggl_search_entries with its filter inputs', async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      const tool = tools.tools.find((t) => t.name === 'toggl_search_entries');

      expect(tool).toBeDefined();
      const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;
      for (const key of [
        'description',
        'project_name',
        'client_name',
        'client_id',
        'tag',
        'billable',
        'start_after',
        'start_before',
        'min_duration_minutes',
        'max_duration_minutes',
        'limit',
      ]) {
        expect(properties).toHaveProperty(key);
      }
    });
  });

  it('registers toggl_delete_entry requiring time_entry_id', async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      const tool = tools.tools.find((t) => t.name === 'toggl_delete_entry');

      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toEqual(['time_entry_id']);
    });
  });

  it('rejects a delete without a valid time_entry_id before any API call', async () => {
    await withClient(async (client) => {
      const missing = await client.callTool({ name: 'toggl_delete_entry', arguments: {} });
      const missingText = (missing.content as Array<{ text?: string }>)[0]?.text ?? '{}';
      const missingPayload = JSON.parse(missingText) as Record<string, unknown>;
      expect(missingPayload.error).toBe(true);
      expect(missingPayload.message).toContain('time_entry_id is required');

      const invalid = await client.callTool({
        name: 'toggl_delete_entry',
        arguments: { time_entry_id: -3 },
      });
      const invalidText = (invalid.content as Array<{ text?: string }>)[0]?.text ?? '{}';
      const invalidPayload = JSON.parse(invalidText) as Record<string, unknown>;
      expect(invalidPayload.error).toBe(true);
      expect(invalidPayload.message).toContain('positive integer');
    });
  });
});
