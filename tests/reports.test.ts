import { describe, expect, it } from 'vitest';
import { normalizeReportRows, summarizeByUser, userDisplayName } from '../src/reports.js';
import type { ReportRow } from '../src/types.js';

describe('userDisplayName', () => {
  it('prefers name, then fullname, then email, then a synthetic label', () => {
    expect(userDisplayName({ id: 1, name: 'Jane', fullname: 'Jane Doe' })).toBe('Jane');
    expect(userDisplayName({ id: 1, fullname: 'Jane Doe' })).toBe('Jane Doe');
    expect(userDisplayName({ id: 1, email: 'jane@example.com' })).toBe('jane@example.com');
    expect(userDisplayName({ id: 7 })).toBe('User 7');
  });
});

describe('normalizeReportRows', () => {
  const row = (overrides: Partial<ReportRow>): ReportRow => ({
    user_id: 1,
    username: 'Jane',
    project_id: 10,
    billable: true,
    description: 'Work',
    time_entries: [
      { id: 100, seconds: 3600, start: '2026-07-10T09:00:00Z', stop: '2026-07-10T10:00:00Z' },
    ],
    ...overrides,
  });

  it('flattens each nested time entry into its own record', () => {
    const rows = [
      row({
        time_entries: [
          { id: 100, seconds: 3600, start: '2026-07-10T09:00:00Z' },
          { id: 101, seconds: 1800, start: '2026-07-11T09:00:00Z' },
        ],
      }),
    ];

    const entries = normalizeReportRows(rows);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: 100,
      user_id: 1,
      description: 'Work',
      project_id: 10,
      billable: true,
      duration_seconds: 3600,
      duration_hours: 1,
    });
    expect(entries[1]).toMatchObject({ id: 101, duration_seconds: 1800, duration_hours: 0.5 });
  });

  it('prefers the workspace user name over the username embedded in the row', () => {
    const entries = normalizeReportRows([row({})], new Map([[1, 'Jane Doe (admin)']]));
    expect(entries[0]?.user_name).toBe('Jane Doe (admin)');
  });

  it('falls back to the row username when the user map is empty (non-admin token)', () => {
    const entries = normalizeReportRows([row({})]);
    expect(entries[0]?.user_name).toBe('Jane');
  });

  it('falls back to a synthetic name when neither is available', () => {
    const entries = normalizeReportRows([row({ username: undefined })]);
    expect(entries[0]?.user_name).toBe('User 1');
  });

  it('handles a row with no nested time_entries by using row-level timing', () => {
    const entries = normalizeReportRows([
      { user_id: 2, username: 'Bob', seconds: 900, start: '2026-07-10T09:00:00Z' } as ReportRow,
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      user_id: 2,
      user_name: 'Bob',
      duration_seconds: 900,
      duration_hours: 0.25,
    });
  });

  it('tolerates missing, negative, and non-numeric durations', () => {
    const entries = normalizeReportRows([
      row({ time_entries: [{ id: 1 }, { id: 2, seconds: -50 }, { id: 3, seconds: 'x' as never }] }),
    ]);

    expect(entries.map((e) => e.duration_seconds)).toEqual([0, 0, 0]);
  });

  it('tolerates a malformed payload without throwing', () => {
    expect(normalizeReportRows([])).toEqual([]);
    expect(normalizeReportRows(null as never)).toEqual([]);
    expect(normalizeReportRows([null as never, undefined as never])).toEqual([]);
  });
});

describe('summarizeByUser', () => {
  const entries = [
    ...normalizeReportRows([
      {
        user_id: 1,
        username: 'Jane',
        project_id: 10,
        billable: true,
        time_entries: [{ id: 1, seconds: 3600 }],
      },
      {
        user_id: 1,
        username: 'Jane',
        project_id: 11,
        billable: false,
        time_entries: [{ id: 2, seconds: 1800 }],
      },
      {
        user_id: 2,
        username: 'Bob',
        project_id: 10,
        billable: true,
        time_entries: [{ id: 3, seconds: 7200 }],
      },
    ]),
  ];

  it('totals hours per user and sorts by total descending', () => {
    const summaries = summarizeByUser(entries);

    expect(summaries.map((s) => s.user_name)).toEqual(['Bob', 'Jane']);
    expect(summaries[0]).toMatchObject({
      user_id: 2,
      user_name: 'Bob',
      total_seconds: 7200,
      total_hours: 2,
      entry_count: 1,
      project_count: 1,
    });
  });

  it('splits billable from non-billable time', () => {
    const jane = summarizeByUser(entries).find((s) => s.user_id === 1);

    expect(jane).toMatchObject({
      total_seconds: 5400,
      total_hours: 1.5,
      billable_seconds: 3600,
      billable_hours: 1,
      entry_count: 2,
      project_count: 2, // worked across two distinct projects
    });
  });

  it('returns an empty list for no entries', () => {
    expect(summarizeByUser([])).toEqual([]);
  });
});

describe('schema drift signal', () => {
  it('yields zero durations when the report shape is unrecognized', () => {
    // This is what toggl_team_summary keys its schema_warning off: rows came back,
    // but no duration could be read from them, so totals must not be trusted.
    const alienRows = [
      { user_id: 1, entries: [{ dur: 3600 }] },
      { user_id: 2, entries: [{ dur: 1800 }] },
    ] as unknown as ReportRow[];

    const entries = normalizeReportRows(alienRows);
    const total = entries.reduce((sum, e) => sum + e.duration_seconds, 0);

    expect(entries.length).toBeGreaterThan(0);
    expect(total).toBe(0);
  });

  it('reports a real total when the expected shape is present', () => {
    const entries = normalizeReportRows([
      { user_id: 1, time_entries: [{ id: 1, seconds: 3600 }] },
    ]);

    expect(entries.reduce((sum, e) => sum + e.duration_seconds, 0)).toBe(3600);
  });
});
