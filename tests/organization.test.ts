import { describe, expect, it, vi } from 'vitest';
import {
  OrganizationResolutionError,
  extractOrganizationUsers,
  organizationIdsFromWorkspaces,
  parseOrganizationId,
  resolveOrganizationId,
} from '../src/organization.js';
import type { Workspace } from '../src/types.js';

const workspace = (id: number, organizationId?: number): Workspace => ({
  id,
  name: `Workspace ${id}`,
  organization_id: organizationId,
});

describe('organizationIdsFromWorkspaces', () => {
  it('derives the distinct organization ids from workspaces', () => {
    expect(
      organizationIdsFromWorkspaces([workspace(1, 100), workspace(2, 100), workspace(3, 200)])
    ).toEqual([100, 200]);
  });

  it('ignores workspaces with no organization id', () => {
    expect(organizationIdsFromWorkspaces([workspace(1), workspace(2, 100)])).toEqual([100]);
    expect(organizationIdsFromWorkspaces([])).toEqual([]);
  });
});

describe('resolveOrganizationId', () => {
  it('prefers an explicit organization id', async () => {
    const getWorkspaces = vi.fn<() => Promise<Workspace[]>>();

    await expect(
      resolveOrganizationId({
        explicitOrganizationId: 123,
        defaultOrganizationId: 456,
        getWorkspaces,
        action: 'testing',
      })
    ).resolves.toBe(123);
    expect(getWorkspaces).not.toHaveBeenCalled();
  });

  it('falls back to the configured default', async () => {
    const getWorkspaces = vi.fn<() => Promise<Workspace[]>>();

    await expect(
      resolveOrganizationId({ defaultOrganizationId: 456, getWorkspaces, action: 'testing' })
    ).resolves.toBe(456);
    expect(getWorkspaces).not.toHaveBeenCalled();
  });

  it('derives the org from workspaces when exactly one exists', async () => {
    const getWorkspaces = vi.fn(async () => [workspace(1, 100), workspace(2, 100)]);

    await expect(resolveOrganizationId({ getWorkspaces, action: 'testing' })).resolves.toBe(100);
  });

  it('fails clearly when the workspaces span multiple organizations', async () => {
    const getWorkspaces = vi.fn(async () => [workspace(1, 100), workspace(2, 200)]);

    await expect(
      resolveOrganizationId({ getWorkspaces, action: 'listing organization users' })
    ).rejects.toMatchObject({
      code: 'ORGANIZATION_REQUIRED',
      available_organizations: [{ id: 100 }, { id: 200 }],
    });

    await expect(
      resolveOrganizationId({ getWorkspaces, action: 'listing organization users' })
    ).rejects.toBeInstanceOf(OrganizationResolutionError);
  });

  it('fails clearly when no organization can be derived', async () => {
    const getWorkspaces = vi.fn(async () => [workspace(1)]);

    await expect(
      resolveOrganizationId({ getWorkspaces, action: 'listing organization users' })
    ).rejects.toMatchObject({ code: 'ORGANIZATION_REQUIRED', available_organizations: [] });
  });
});

describe('parseOrganizationId', () => {
  it('accepts only positive integers', () => {
    expect(parseOrganizationId(42)).toBe(42);
    expect(parseOrganizationId('42')).toBe(42);
    expect(parseOrganizationId(0)).toBeUndefined();
    expect(parseOrganizationId(-1)).toBeUndefined();
    expect(parseOrganizationId('abc')).toBeUndefined();
    expect(parseOrganizationId(undefined)).toBeUndefined();
    expect(parseOrganizationId('')).toBeUndefined();
  });
});

describe('extractOrganizationUsers', () => {
  it('accepts a bare array', () => {
    expect(extractOrganizationUsers([{ id: 1 }])).toEqual([{ id: 1 }]);
  });

  it('accepts a { data: [...] } envelope', () => {
    expect(extractOrganizationUsers({ data: [{ id: 1 }] })).toEqual([{ id: 1 }]);
  });

  it('returns an empty array for anything else', () => {
    expect(extractOrganizationUsers(null)).toEqual([]);
    expect(extractOrganizationUsers({ error: 'forbidden' })).toEqual([]);
    expect(extractOrganizationUsers('nope')).toEqual([]);
  });
});
