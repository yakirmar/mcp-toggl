import { secondsToHours } from './utils.js';
import type { ReportRow, TeamEntry, TeamUserSummary, WorkspaceUser } from './types.js';

// Toggl's Reports API v3 does not publish a response schema, so every field is
// treated as optional and each row is normalized defensively. A row groups one
// or more individual time entries under `time_entries`; older/other shapes may
// carry the timing on the row itself, so we fall back to that.

export function userDisplayName(user: WorkspaceUser): string {
  return user.name || user.fullname || user.email || `User ${user.id}`;
}

function durationSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// Flatten grouped report rows into one record per individual time entry.
export function normalizeReportRows(
  rows: ReportRow[],
  userNames: Map<number, string> = new Map()
): TeamEntry[] {
  if (!Array.isArray(rows)) return [];

  const entries: TeamEntry[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    const base = {
      user_id: row.user_id,
      user_name:
        (row.user_id !== undefined ? userNames.get(row.user_id) : undefined) ??
        row.username ??
        (row.user_id !== undefined ? `User ${row.user_id}` : 'Unknown user'),
      description: row.description,
      project_id: row.project_id,
      task_id: row.task_id,
      billable: row.billable,
      tag_ids: Array.isArray(row.tag_ids) ? row.tag_ids : undefined,
    };

    const timeEntries = Array.isArray(row.time_entries) ? row.time_entries : [];

    if (timeEntries.length === 0) {
      // Row carries no nested entries — fall back to any row-level timing.
      const seconds = durationSeconds((row as Record<string, unknown>).seconds);
      entries.push({
        ...base,
        id: typeof row.id === 'number' ? row.id : undefined,
        start: typeof row.start === 'string' ? row.start : undefined,
        stop: typeof row.stop === 'string' ? row.stop : undefined,
        duration_seconds: seconds,
        duration_hours: secondsToHours(seconds),
      });
      continue;
    }

    for (const entry of timeEntries) {
      const seconds = durationSeconds(entry?.seconds);
      entries.push({
        ...base,
        id: entry?.id,
        start: entry?.start,
        stop: entry?.stop,
        duration_seconds: seconds,
        duration_hours: secondsToHours(seconds),
      });
    }
  }

  return entries;
}

// Aggregate flattened entries into per-user totals, newest-heaviest first.
// Derived from the detailed report rather than the separate summary endpoint so
// there is only one response shape to depend on.
export function summarizeByUser(entries: TeamEntry[]): TeamUserSummary[] {
  const byUser = new Map<string, TeamEntry[]>();

  for (const entry of entries) {
    const key = entry.user_id !== undefined ? String(entry.user_id) : entry.user_name || 'unknown';
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key)!.push(entry);
  }

  const summaries: TeamUserSummary[] = [];

  byUser.forEach((userEntries) => {
    const totalSeconds = userEntries.reduce((sum, e) => sum + e.duration_seconds, 0);
    const billableSeconds = userEntries
      .filter((e) => e.billable)
      .reduce((sum, e) => sum + e.duration_seconds, 0);
    const projectIds = new Set(
      userEntries.map((e) => e.project_id).filter((id): id is number => id !== undefined)
    );

    summaries.push({
      user_id: userEntries[0]?.user_id,
      user_name: userEntries[0]?.user_name || 'Unknown user',
      total_seconds: totalSeconds,
      total_hours: secondsToHours(totalSeconds),
      billable_seconds: billableSeconds,
      billable_hours: secondsToHours(billableSeconds),
      entry_count: userEntries.length,
      project_count: projectIds.size,
    });
  });

  summaries.sort((a, b) => b.total_seconds - a.total_seconds);
  return summaries;
}
