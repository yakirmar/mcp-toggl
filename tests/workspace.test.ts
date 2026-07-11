import { describe, expect, it, vi } from 'vitest';
import {
  resolveProjectForClient,
  resolveWorkspaceId,
  WorkspaceResolutionError,
} from '../src/workspace.js';
import type { Project, Workspace } from '../src/types.js';

const workspace = (id: number, name: string): Workspace => ({ id, name });

const project = (id: number, name: string, clientId?: number): Project => ({
  id,
  workspace_id: 1,
  name,
  client_id: clientId,
});

describe('workspace resolution', () => {
  it('uses an explicit workspace id first', async () => {
    const getWorkspaces = vi.fn<() => Promise<Workspace[]>>();

    await expect(
      resolveWorkspaceId({
        explicitWorkspaceId: 123,
        defaultWorkspaceId: 456,
        getWorkspaces,
        action: 'testing',
      })
    ).resolves.toBe(123);
    expect(getWorkspaces).not.toHaveBeenCalled();
  });

  it('uses the configured default workspace when no explicit id is provided', async () => {
    const getWorkspaces = vi.fn<() => Promise<Workspace[]>>();

    await expect(
      resolveWorkspaceId({
        defaultWorkspaceId: 456,
        getWorkspaces,
        action: 'testing',
      })
    ).resolves.toBe(456);
    expect(getWorkspaces).not.toHaveBeenCalled();
  });

  it('auto-selects the only available workspace', async () => {
    const getWorkspaces = vi.fn(async () => [workspace(789, 'Solo')]);

    await expect(
      resolveWorkspaceId({
        getWorkspaces,
        action: 'testing',
      })
    ).resolves.toBe(789);
  });

  it('fails clearly when multiple workspaces require a choice', async () => {
    const getWorkspaces = vi.fn(async () => [workspace(1, 'First'), workspace(2, 'Second')]);

    await expect(
      resolveWorkspaceId({
        getWorkspaces,
        action: 'listing projects',
      })
    ).rejects.toMatchObject({
      code: 'WORKSPACE_REQUIRED',
      available_workspaces: [
        { id: 1, name: 'First' },
        { id: 2, name: 'Second' },
      ],
    });

    await expect(
      resolveWorkspaceId({
        getWorkspaces,
        action: 'listing projects',
      })
    ).rejects.toBeInstanceOf(WorkspaceResolutionError);
  });
});

describe('resolveProjectForClient', () => {
  const projects = [
    project(10, 'Alpha', 100),
    project(11, 'Beta', 100),
    project(20, 'Gamma', 200),
    project(30, 'No Client'),
  ];

  it('auto-selects the sole project for a client', () => {
    expect(resolveProjectForClient(projects, 200)).toBe(20);
  });

  it('verifies an explicit project belongs to the client', () => {
    expect(resolveProjectForClient(projects, 100, 11)).toBe(11);
  });

  it('rejects an explicit project that does not belong to the client', () => {
    expect(() => resolveProjectForClient(projects, 100, 20)).toThrow(
      /does not belong to client 100/
    );
  });

  it('requires project_id when a client has multiple projects and lists candidates', () => {
    expect(() => resolveProjectForClient(projects, 100)).toThrow(/has multiple projects/);
    // The error should name the candidate projects to guide the caller.
    expect(() => resolveProjectForClient(projects, 100)).toThrow(/10 \(Alpha\), 11 \(Beta\)/);
  });

  it('errors clearly when a client has no projects', () => {
    expect(() => resolveProjectForClient(projects, 999)).toThrow(/No projects found for client 999/);
  });

  it('does not treat a project without a client as belonging to any client', () => {
    // Project 30 has no client_id; it must not satisfy an explicit client request.
    expect(() => resolveProjectForClient(projects, 200, 30)).toThrow(
      /does not belong to client 200/
    );
  });

  it('rejects an explicit project that belongs to a different client', () => {
    expect(() => resolveProjectForClient(projects, 200, 10)).toThrow(/does not belong to client 200/);
  });
});
