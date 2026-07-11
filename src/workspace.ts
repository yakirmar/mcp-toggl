import type { Project, Workspace } from './types.js';

export interface WorkspaceSummary {
  id: number;
  name: string;
}

export class WorkspaceResolutionError extends Error {
  readonly code = 'WORKSPACE_REQUIRED';
  readonly tip: string;
  readonly available_workspaces: WorkspaceSummary[];

  constructor(action: string, workspaces: WorkspaceSummary[]) {
    const workspaceList = workspaces
      .map((workspace) => `${workspace.id} (${workspace.name})`)
      .join(', ');
    super(
      workspaces.length > 0
        ? `Workspace ID required for ${action}. Set TOGGL_DEFAULT_WORKSPACE_ID or provide workspace_id. Available workspaces: ${workspaceList}`
        : `Workspace ID required for ${action}, but no Toggl workspaces were returned.`
    );
    this.name = 'WorkspaceResolutionError';
    this.available_workspaces = workspaces;
    this.tip =
      'Pass workspace_id explicitly, or set TOGGL_DEFAULT_WORKSPACE_ID in your MCP server environment.';
  }
}

interface ResolveWorkspaceOptions {
  explicitWorkspaceId?: unknown;
  defaultWorkspaceId?: number;
  getWorkspaces: () => Promise<Workspace[]>;
  action: string;
}

export async function resolveWorkspaceId({
  explicitWorkspaceId,
  defaultWorkspaceId,
  getWorkspaces,
  action,
}: ResolveWorkspaceOptions): Promise<number> {
  const explicit = parseWorkspaceId(explicitWorkspaceId);
  if (explicit !== undefined) return explicit;

  if (defaultWorkspaceId !== undefined) return defaultWorkspaceId;

  const workspaces = await getWorkspaces();
  if (workspaces.length === 1) return workspaces[0]!.id;

  throw new WorkspaceResolutionError(
    action,
    workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
    }))
  );
}

function formatProjectList(projects: Project[]): string {
  return projects.map((project) => `${project.id} (${project.name})`).join(', ');
}

// Resolve which project a time entry should attach to when a client is given.
// Toggl entries attach to a project, not a client directly, so this maps the
// requested client to a concrete project:
//   - project_id given  → verify it belongs to the client
//   - exactly one project for the client → use it
//   - zero or many → throw with actionable guidance
export function resolveProjectForClient(
  projects: Project[],
  clientId: number,
  projectId?: number
): number {
  const clientProjects = projects.filter((project) => project.client_id === clientId);

  if (projectId !== undefined) {
    if (!clientProjects.some((project) => project.id === projectId)) {
      throw new Error(
        `Project ${projectId} does not belong to client ${clientId}. ` +
          `Projects for this client: ${clientProjects.length ? formatProjectList(clientProjects) : 'none'}.`
      );
    }
    return projectId;
  }

  if (clientProjects.length === 1) return clientProjects[0]!.id;

  if (clientProjects.length === 0) {
    throw new Error(
      `No projects found for client ${clientId}. Provide project_id, ` +
        `or create a project for this client first.`
    );
  }

  throw new Error(
    `Client ${clientId} has multiple projects; specify project_id. ` +
      `Candidates: ${formatProjectList(clientProjects)}.`
  );
}

export function parseWorkspaceId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
