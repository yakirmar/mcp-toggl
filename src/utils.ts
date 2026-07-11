import type {
  HydratedTimeEntry,
  DailyReport,
  WeeklyReport,
  ProjectSummary,
  WorkspaceSummary,
  ReportEntry,
  DateRange,
  DatePeriod,
} from './types.js';

// Convert seconds to hours with decimal precision
export function secondsToHours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}

// Format duration for display
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

// Parse ISO date to local date string
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Format a Date as YYYY-MM-DD in the host's local timezone.
export function toLocalYMD(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Parse a YYYY-MM-DD string into a Date at local midnight.
export function parseLocalYMD(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid date format: ${value}. Expected YYYY-MM-DD.`);
  }

  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Invalid calendar date: ${value}`);
  }

  return date;
}

// Resolved interval for a completed time entry.
export interface TimeEntryInterval {
  start: string; // ISO 8601 datetime
  stop: string; // ISO 8601 datetime
  duration: number; // Seconds, always positive
}

function parseDateTime(value: unknown, field: string): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be an ISO 8601 datetime string`);
  }

  const trimmed = value.trim();

  // A bare YYYY-MM-DD is treated as local midnight (consistent with the rest of
  // the codebase). `new Date('YYYY-MM-DD')` would parse it as UTC midnight, which
  // shifts the entry a day in timezones behind/ahead of UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return parseLocalYMD(trimmed);
  }

  // Datetimes with an offset (Z or ±hh:mm) are absolute; datetimes without one
  // are interpreted in the host's local timezone by the Date constructor.
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Invalid ${field}: ${value}. Expected an ISO 8601 datetime ` +
        `(e.g. 2026-07-11T09:00:00Z or 2026-07-11T09:00:00+03:00).`
    );
  }

  return date;
}

// Build a completed time entry interval from a start plus exactly one of an end
// time or a length in minutes. Returns ISO 8601 start/stop and positive duration
// seconds, matching what Toggl's create time entry endpoint expects.
export function buildTimeEntryInterval(args: {
  start?: unknown;
  end?: unknown;
  duration_minutes?: unknown;
}): TimeEntryInterval {
  const start = parseDateTime(args.start, 'start');

  const hasEnd = args.end !== undefined && args.end !== null && args.end !== '';
  const hasDuration = args.duration_minutes !== undefined && args.duration_minutes !== null;

  if (hasEnd === hasDuration) {
    throw new Error('Provide exactly one of end or duration_minutes.');
  }

  let stop: Date;
  if (hasEnd) {
    stop = parseDateTime(args.end, 'end');
  } else {
    const minutes = args.duration_minutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      throw new Error('duration_minutes must be a positive number.');
    }
    stop = new Date(start.getTime() + minutes * 60_000);
  }

  const duration = Math.round((stop.getTime() - start.getTime()) / 1000);
  if (duration <= 0) {
    throw new Error('end must be after start.');
  }

  return {
    start: start.toISOString(),
    stop: stop.toISOString(),
    duration,
  };
}

// Criteria for narrowing a set of already-hydrated time entries. All provided
// fields combine with AND. Text fields are case-insensitive substring matches.
export interface EntrySearchCriteria {
  description?: string;
  project_name?: string;
  client_name?: string;
  project_id?: number;
  client_id?: number;
  workspace_id?: number;
  tag?: string;
  billable?: boolean;
  start_after?: string; // ISO 8601 datetime
  start_before?: string; // ISO 8601 datetime
  min_duration_minutes?: number;
  max_duration_minutes?: number;
}

function includesCI(haystack: string | undefined, needle: string): boolean {
  return (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}

function validateDurationBound(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return value * 60;
}

// Filter hydrated entries by the given criteria. Pure and side-effect free so
// the search logic can be unit tested independently of the Toggl API.
export function filterHydratedEntries(
  entries: HydratedTimeEntry[],
  criteria: EntrySearchCriteria
): HydratedTimeEntry[] {
  const startAfter = criteria.start_after
    ? parseDateTime(criteria.start_after, 'start_after').getTime()
    : undefined;
  const startBefore = criteria.start_before
    ? parseDateTime(criteria.start_before, 'start_before').getTime()
    : undefined;
  const minSeconds = validateDurationBound(criteria.min_duration_minutes, 'min_duration_minutes');
  const maxSeconds = validateDurationBound(criteria.max_duration_minutes, 'max_duration_minutes');

  return entries.filter((entry) => {
    if (criteria.description && !includesCI(entry.description, criteria.description)) return false;
    if (criteria.project_name && !includesCI(entry.project_name, criteria.project_name)) {
      return false;
    }
    if (criteria.client_name && !includesCI(entry.client_name, criteria.client_name)) return false;
    if (criteria.project_id !== undefined && entry.project_id !== criteria.project_id) return false;
    if (criteria.client_id !== undefined && entry.client_id !== criteria.client_id) return false;
    if (criteria.workspace_id !== undefined && entry.workspace_id !== criteria.workspace_id) {
      return false;
    }
    if (criteria.billable !== undefined && Boolean(entry.billable) !== criteria.billable) {
      return false;
    }
    if (criteria.tag) {
      const names = entry.tag_names ?? entry.tags ?? [];
      if (!names.some((name) => includesCI(name, criteria.tag!))) return false;
    }
    if (startAfter !== undefined || startBefore !== undefined) {
      const startMs = new Date(entry.start).getTime();
      if (startAfter !== undefined && startMs < startAfter) return false;
      if (startBefore !== undefined && startMs > startBefore) return false;
    }
    if (minSeconds !== undefined && entry.duration_seconds < minSeconds) return false;
    if (maxSeconds !== undefined && entry.duration_seconds > maxSeconds) return false;
    return true;
  });
}

export function isDatePeriod(value: unknown): value is DatePeriod {
  return (
    value === 'today' ||
    value === 'yesterday' ||
    value === 'week' ||
    value === 'lastWeek' ||
    value === 'month' ||
    value === 'lastMonth'
  );
}

export function localDateRangeFromArgs(
  args: Record<string, unknown> | undefined
): { start: Date | null; end: Date | null } | null {
  if (args?.period !== undefined) {
    if (!isDatePeriod(args.period)) {
      throw new Error(
        `Invalid period: ${String(args.period)}. Must be one of: today, yesterday, week, lastWeek, month, lastMonth`
      );
    }
    return getDateRange(args.period);
  }

  const startValue = args?.start_date;
  const endValue = args?.end_date;

  if (startValue === undefined && endValue === undefined) {
    return null;
  }

  if (startValue !== undefined && typeof startValue !== 'string') {
    throw new Error('start_date must be a YYYY-MM-DD string');
  }
  if (endValue !== undefined && typeof endValue !== 'string') {
    throw new Error('end_date must be a YYYY-MM-DD string');
  }

  const start = startValue ? parseLocalYMD(startValue) : null;
  const end = endValue ? parseLocalYMD(endValue) : null;
  if (end) {
    end.setDate(end.getDate() + 1);
  }

  if (start && end && start >= end) {
    throw new Error('start_date must be before or equal to end_date');
  }

  return { start, end };
}

// Get date range for various periods
export function getDateRange(period: DatePeriod): DateRange {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  switch (period) {
    case 'today': {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return { start: today, end: tomorrow };
    }

    case 'yesterday': {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return { start: yesterday, end: today };
    }

    case 'week': {
      const dayOfWeek = today.getDay();
      const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
      const monday = new Date(today);
      monday.setDate(diff);
      const nextMonday = new Date(monday);
      nextMonday.setDate(nextMonday.getDate() + 7);
      return { start: monday, end: nextMonday };
    }

    case 'lastWeek': {
      const dayOfWeek = today.getDay();
      const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1) - 7;
      const monday = new Date(today);
      monday.setDate(diff);
      const nextMonday = new Date(monday);
      nextMonday.setDate(nextMonday.getDate() + 7);
      return { start: monday, end: nextMonday };
    }

    case 'month': {
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      const firstDayNextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      return { start: firstDay, end: firstDayNextMonth };
    }

    case 'lastMonth': {
      const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const firstDayNextMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      return { start: firstDay, end: firstDayNextMonth };
    }
  }
}

// Group time entries by date
export function groupEntriesByDate(entries: HydratedTimeEntry[]): Map<string, HydratedTimeEntry[]> {
  const grouped = new Map<string, HydratedTimeEntry[]>();

  entries.forEach((entry) => {
    const date = toLocalYMD(new Date(entry.start));
    if (!grouped.has(date)) {
      grouped.set(date, []);
    }
    grouped.get(date)!.push(entry);
  });

  return grouped;
}

// Group time entries by project
export function groupEntriesByProject(
  entries: HydratedTimeEntry[]
): Map<string, HydratedTimeEntry[]> {
  const grouped = new Map<string, HydratedTimeEntry[]>();

  entries.forEach((entry) => {
    const key = entry.project_name || 'No Project';
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(entry);
  });

  return grouped;
}

// Group time entries by workspace
export function groupEntriesByWorkspace(
  entries: HydratedTimeEntry[]
): Map<string, HydratedTimeEntry[]> {
  const grouped = new Map<string, HydratedTimeEntry[]>();

  entries.forEach((entry) => {
    const key = entry.workspace_name;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(entry);
  });

  return grouped;
}

function effectiveDurationSeconds(entry: HydratedTimeEntry): number {
  if (entry.duration_seconds !== undefined) return entry.duration_seconds;

  if (entry.duration < 0) {
    return Math.max(0, Math.floor((Date.now() - new Date(entry.start).getTime()) / 1000));
  }

  return entry.duration;
}

// Calculate total duration from entries
export function calculateTotalDuration(entries: HydratedTimeEntry[]): number {
  return entries.reduce((total, entry) => total + effectiveDurationSeconds(entry), 0);
}

// Create a report entry from a hydrated time entry
export function createReportEntry(entry: HydratedTimeEntry): ReportEntry {
  const duration = effectiveDurationSeconds(entry);
  const tagNames = entry.tag_names ?? [];
  const tags = entry.tags ?? [];

  return {
    id: entry.id,
    workspace: entry.workspace_name,
    project: entry.project_name,
    client: entry.client_name,
    task: entry.task_name,
    description: entry.description,
    start: entry.start,
    stop: entry.stop,
    duration_hours: secondsToHours(duration),
    duration_seconds: duration,
    tags: tagNames.length > 0 ? tagNames : tags,
    billable: entry.billable,
  };
}

// Generate project summary
export function generateProjectSummary(
  projectName: string,
  entries: HydratedTimeEntry[]
): ProjectSummary {
  const totalSeconds = calculateTotalDuration(entries);
  const billableSeconds = entries
    .filter((e) => e.billable)
    .reduce((total, e) => total + effectiveDurationSeconds(e), 0);

  return {
    project_id: entries[0]?.project_id,
    project_name: projectName,
    client_name: entries[0]?.client_name,
    workspace_name: entries[0]?.workspace_name || 'Unknown',
    total_hours: secondsToHours(totalSeconds),
    total_seconds: totalSeconds,
    billable_hours: secondsToHours(billableSeconds),
    billable_seconds: billableSeconds,
    entry_count: entries.length,
  };
}

// Generate workspace summary
export function generateWorkspaceSummary(
  workspaceName: string,
  workspaceId: number,
  entries: HydratedTimeEntry[]
): WorkspaceSummary {
  const totalSeconds = calculateTotalDuration(entries);
  const billableSeconds = entries
    .filter((e) => e.billable)
    .reduce((total, e) => total + effectiveDurationSeconds(e), 0);

  const projectIds = new Set(entries.map((e) => e.project_id).filter(Boolean));

  return {
    workspace_id: workspaceId,
    workspace_name: workspaceName,
    total_hours: secondsToHours(totalSeconds),
    total_seconds: totalSeconds,
    billable_hours: secondsToHours(billableSeconds),
    billable_seconds: billableSeconds,
    project_count: projectIds.size,
    entry_count: entries.length,
  };
}

// Generate daily report
export function generateDailyReport(date: string, entries: HydratedTimeEntry[]): DailyReport {
  const totalSeconds = calculateTotalDuration(entries);
  const reportEntries = entries.map(createReportEntry);

  // Group by project
  const byProject = groupEntriesByProject(entries);
  const projectSummaries: ProjectSummary[] = [];
  byProject.forEach((projectEntries, projectName) => {
    projectSummaries.push(generateProjectSummary(projectName, projectEntries));
  });

  // Group by workspace
  const byWorkspace = groupEntriesByWorkspace(entries);
  const workspaceSummaries: WorkspaceSummary[] = [];
  byWorkspace.forEach((wsEntries, wsName) => {
    const wsId = wsEntries[0]?.workspace_id || 0;
    workspaceSummaries.push(generateWorkspaceSummary(wsName, wsId, wsEntries));
  });

  return {
    date,
    total_hours: secondsToHours(totalSeconds),
    total_seconds: totalSeconds,
    entries: reportEntries,
    by_project: projectSummaries,
    by_workspace: workspaceSummaries,
  };
}

// Generate weekly report
export function generateWeeklyReport(
  weekStart: Date,
  weekEnd: Date,
  entries: HydratedTimeEntry[]
): WeeklyReport {
  const totalSeconds = calculateTotalDuration(entries);

  // Group by date for daily breakdown
  const byDate = groupEntriesByDate(entries);
  const dailyBreakdown: DailyReport[] = [];
  byDate.forEach((dateEntries, date) => {
    dailyBreakdown.push(generateDailyReport(date, dateEntries));
  });

  // Sort daily reports
  dailyBreakdown.sort((a, b) => a.date.localeCompare(b.date));

  // Overall project summaries
  const byProject = groupEntriesByProject(entries);
  const projectSummaries: ProjectSummary[] = [];
  byProject.forEach((projectEntries, projectName) => {
    projectSummaries.push(generateProjectSummary(projectName, projectEntries));
  });

  // Overall workspace summaries
  const byWorkspace = groupEntriesByWorkspace(entries);
  const workspaceSummaries: WorkspaceSummary[] = [];
  byWorkspace.forEach((wsEntries, wsName) => {
    const wsId = wsEntries[0]?.workspace_id || 0;
    workspaceSummaries.push(generateWorkspaceSummary(wsName, wsId, wsEntries));
  });

  return {
    week_start: toLocalYMD(weekStart),
    week_end: toLocalYMD(weekEnd),
    total_hours: secondsToHours(totalSeconds),
    total_seconds: totalSeconds,
    daily_breakdown: dailyBreakdown,
    by_project: projectSummaries,
    by_workspace: workspaceSummaries,
  };
}

// Format report for display
export function formatReportForDisplay(report: DailyReport | WeeklyReport): string {
  const lines: string[] = [];

  if ('week_start' in report) {
    // Weekly report
    lines.push(`📊 Weekly Report (${report.week_start} to ${report.week_end})`);
    lines.push(`Total: ${report.total_hours} hours`);
    lines.push('');

    lines.push('📅 Daily Breakdown:');
    report.daily_breakdown.forEach((day) => {
      lines.push(`  ${day.date}: ${day.total_hours}h`);
    });
  } else {
    // Daily report
    lines.push(`📊 Daily Report for ${report.date}`);
    lines.push(`Total: ${report.total_hours} hours`);
  }

  lines.push('');
  lines.push('🏢 By Workspace:');
  report.by_workspace.forEach((ws) => {
    lines.push(`  ${ws.workspace_name}: ${ws.total_hours}h (${ws.project_count} projects)`);
  });

  lines.push('');
  lines.push('📁 By Project:');
  report.by_project.forEach((proj) => {
    const client = proj.client_name ? ` (${proj.client_name})` : '';
    lines.push(`  ${proj.project_name}${client}: ${proj.total_hours}h`);
  });

  return lines.join('\n');
}
