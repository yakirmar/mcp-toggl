import type { OrganizationUser, Workspace } from './types.js';

export interface OrganizationSummary {
  id: number;
}

export class OrganizationResolutionError extends Error {
  readonly code = 'ORGANIZATION_REQUIRED';
  readonly tip: string;
  readonly available_organizations: OrganizationSummary[];

  constructor(action: string, organizations: OrganizationSummary[]) {
    const list = organizations.map((org) => String(org.id)).join(', ');
    super(
      organizations.length > 0
        ? `Organization ID required for ${action}. Provide organization_id or set TOGGL_DEFAULT_ORG_ID. Available organizations: ${list}`
        : `Organization ID required for ${action}, but no organization could be derived from your workspaces.`
    );
    this.name = 'OrganizationResolutionError';
    this.available_organizations = organizations;
    this.tip =
      'Pass organization_id explicitly, or set TOGGL_DEFAULT_ORG_ID in your MCP server environment.';
  }
}

// Toggl has no "list my organizations" endpoint, but every workspace carries the
// organization it belongs to — so the set of orgs is derivable from the workspaces.
export function organizationIdsFromWorkspaces(workspaces: Workspace[]): number[] {
  const ids = workspaces
    .map((workspace) => workspace.organization_id)
    .filter((id): id is number => typeof id === 'number' && id > 0);
  return [...new Set(ids)];
}

interface ResolveOrganizationOptions {
  explicitOrganizationId?: unknown;
  defaultOrganizationId?: number;
  getWorkspaces: () => Promise<Workspace[]>;
  action: string;
}

export async function resolveOrganizationId({
  explicitOrganizationId,
  defaultOrganizationId,
  getWorkspaces,
  action,
}: ResolveOrganizationOptions): Promise<number> {
  const explicit = parseOrganizationId(explicitOrganizationId);
  if (explicit !== undefined) return explicit;

  if (defaultOrganizationId !== undefined) return defaultOrganizationId;

  const ids = organizationIdsFromWorkspaces(await getWorkspaces());
  if (ids.length === 1) return ids[0]!;

  throw new OrganizationResolutionError(
    action,
    ids.map((id) => ({ id }))
  );
}

export function parseOrganizationId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// The org users endpoint is documented for its parameters but not its exact
// envelope, so accept a bare array or a { data: [...] } wrapper.
export function extractOrganizationUsers(payload: unknown): OrganizationUser[] {
  if (Array.isArray(payload)) return payload as OrganizationUser[];

  if (payload && typeof payload === 'object') {
    const data = (payload as Record<string, unknown>).data;
    if (Array.isArray(data)) return data as OrganizationUser[];
  }

  return [];
}

export interface NormalizedOrganizationUser {
  organization_user_id?: number;
  user_id?: number;
  name: string;
  email?: string;
  organization_admin: boolean;
  workspace_admin: boolean;
  active: boolean;
  role_id?: number;
  workspace_count?: number;
}

export function normalizeOrganizationUser(user: OrganizationUser): NormalizedOrganizationUser {
  const name =
    user.name || user.fullname || user.email || `User ${user.user_id ?? user.id ?? 'unknown'}`;

  return {
    organization_user_id: user.id,
    // Prefer the Toggl user id — that is what time entries are keyed by, so it is
    // the id to feed into toggl_team_entries / toggl_team_summary.
    user_id: user.user_id,
    name,
    email: user.email,
    organization_admin: Boolean(user.organization_admin ?? user.admin),
    workspace_admin: Boolean(user.workspace_admin),
    // Toggl marks absence-of-active as `inactive`; treat missing as active.
    active: user.inactive === undefined ? true : !user.inactive,
    role_id: user.role_id,
    workspace_count: Array.isArray(user.workspaces) ? user.workspaces.length : undefined,
  };
}
