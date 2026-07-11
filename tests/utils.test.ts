process.env.TZ = 'Europe/London';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTimeEntryInterval,
  filterHydratedEntries,
  generateWeeklyReport,
  formatDuration,
  getDateRange,
  isDatePeriod,
  localDateRangeFromArgs,
  parseLocalYMD,
  secondsToHours,
  toLocalYMD,
} from '../src/utils.js';
import type { HydratedTimeEntry } from '../src/types.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('time formatting utilities', () => {
  it('converts seconds to decimal hours', () => {
    expect(secondsToHours(5400)).toBe(1.5);
  });

  it('formats durations compactly', () => {
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(61)).toBe('1m 1s');
    expect(formatDuration(42)).toBe('42s');
  });
});

describe('local date ranges', () => {
  it('formats local midnight without shifting east-of-UTC dates backward', () => {
    const localMidnight = new Date(2026, 3, 19);

    expect(localMidnight.toISOString().split('T')[0]).toBe('2026-04-18');
    expect(toLocalYMD(localMidnight)).toBe('2026-04-19');
  });

  it('parses YYYY-MM-DD at local midnight', () => {
    const parsed = parseLocalYMD('2026-04-19');

    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(3);
    expect(parsed.getDate()).toBe(19);
    expect(parsed.getHours()).toBe(0);
  });

  it('rejects malformed and impossible local dates', () => {
    expect(() => parseLocalYMD('2026-4-19')).toThrow('Invalid date format');
    expect(() => parseLocalYMD('2026-02-30')).toThrow('Invalid calendar date');
  });

  it('validates supported period names', () => {
    expect(isDatePeriod('today')).toBe(true);
    expect(isDatePeriod('lastMonth')).toBe(true);
    expect(isDatePeriod('quarter')).toBe(false);
  });

  it('resolves inclusive end dates to exclusive local boundaries', () => {
    const range = localDateRangeFromArgs({
      start_date: '2026-04-19',
      end_date: '2026-04-20',
    });

    expect(range?.start && toLocalYMD(range.start)).toBe('2026-04-19');
    expect(range?.end && toLocalYMD(range.end)).toBe('2026-04-21');
  });

  it('uses exclusive local period ends for Toggl date filters', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T11:00:00Z'));

    const week = getDateRange('week');
    const month = getDateRange('month');

    expect(toLocalYMD(week.start)).toBe('2026-04-13');
    expect(toLocalYMD(week.end)).toBe('2026-04-20');
    expect(toLocalYMD(month.start)).toBe('2026-04-01');
    expect(toLocalYMD(month.end)).toBe('2026-05-01');
  });

  it('groups weekly report entries by local date', () => {
    const entry = {
      id: 1,
      workspace_id: 1,
      workspace_name: 'Workspace',
      start: '2026-04-18T23:30:00.000Z',
      stop: '2026-04-19T00:00:00.000Z',
      duration: 1800,
      description: 'Late work',
      billable: false,
      tags: [],
    } as HydratedTimeEntry;

    const report = generateWeeklyReport(parseLocalYMD('2026-04-13'), parseLocalYMD('2026-04-19'), [
      entry,
    ]);

    expect(report.daily_breakdown).toHaveLength(1);
    expect(report.daily_breakdown[0]?.date).toBe('2026-04-19');
  });
});

describe('buildTimeEntryInterval', () => {
  it('derives stop and duration from a start and duration_minutes', () => {
    const interval = buildTimeEntryInterval({
      start: '2026-07-11T09:00:00Z',
      duration_minutes: 90,
    });

    expect(interval).toEqual({
      start: '2026-07-11T09:00:00.000Z',
      stop: '2026-07-11T10:30:00.000Z',
      duration: 5400,
    });
  });

  it('derives duration from a start and end time', () => {
    const interval = buildTimeEntryInterval({
      start: '2026-07-11T09:00:00Z',
      end: '2026-07-11T09:45:00Z',
    });

    expect(interval).toEqual({
      start: '2026-07-11T09:00:00.000Z',
      stop: '2026-07-11T09:45:00.000Z',
      duration: 2700,
    });
  });

  it('treats a bare YYYY-MM-DD as local midnight (Europe/London), not UTC', () => {
    // Europe/London is UTC+1 (BST) in July, so local midnight is 23:00 UTC the prior day.
    const interval = buildTimeEntryInterval({
      start: '2026-07-11',
      duration_minutes: 60,
    });

    expect(interval.start).toBe('2026-07-10T23:00:00.000Z');
    expect(interval.stop).toBe('2026-07-11T00:00:00.000Z');
    expect(interval.duration).toBe(3600);
  });

  it('interprets an offset-less datetime in the host local timezone (Europe/London BST)', () => {
    // 09:00 local in BST (UTC+1) is 08:00 UTC — no offset means "the computer's timezone".
    const interval = buildTimeEntryInterval({
      start: '2026-07-11T09:00:00',
      duration_minutes: 60,
    });

    expect(interval.start).toBe('2026-07-11T08:00:00.000Z');
    expect(interval.stop).toBe('2026-07-11T09:00:00.000Z');
  });

  it('honors an explicit timezone offset', () => {
    const interval = buildTimeEntryInterval({
      start: '2026-07-11T09:00:00+03:00',
      duration_minutes: 30,
    });

    expect(interval.start).toBe('2026-07-11T06:00:00.000Z');
    expect(interval.stop).toBe('2026-07-11T06:30:00.000Z');
  });

  it('requires exactly one of end or duration_minutes', () => {
    expect(() => buildTimeEntryInterval({ start: '2026-07-11T09:00:00Z' })).toThrow(
      /exactly one of end or duration_minutes/
    );
    expect(() =>
      buildTimeEntryInterval({
        start: '2026-07-11T09:00:00Z',
        end: '2026-07-11T10:00:00Z',
        duration_minutes: 60,
      })
    ).toThrow(/exactly one of end or duration_minutes/);
  });

  it('rejects a non-positive duration and an end before start', () => {
    expect(() =>
      buildTimeEntryInterval({ start: '2026-07-11T09:00:00Z', duration_minutes: 0 })
    ).toThrow(/positive number/);
    expect(() =>
      buildTimeEntryInterval({
        start: '2026-07-11T10:00:00Z',
        end: '2026-07-11T09:00:00Z',
      })
    ).toThrow(/end must be after start/);
  });

  it('rejects invalid or missing start', () => {
    expect(() => buildTimeEntryInterval({ duration_minutes: 60 })).toThrow(
      /start must be an ISO 8601 datetime/
    );
    expect(() =>
      buildTimeEntryInterval({ start: 'not-a-date', duration_minutes: 60 })
    ).toThrow(/Invalid start/);
  });

  it('rejects a blank start string', () => {
    expect(() => buildTimeEntryInterval({ start: '   ', duration_minutes: 60 })).toThrow(
      /start must be an ISO 8601 datetime/
    );
  });

  it('treats an empty-string end as not provided and falls back to duration_minutes', () => {
    const interval = buildTimeEntryInterval({
      start: '2026-07-11T09:00:00Z',
      end: '',
      duration_minutes: 15,
    });

    expect(interval.stop).toBe('2026-07-11T09:15:00.000Z');
    expect(interval.duration).toBe(900);
  });

  it('rejects a non-numeric duration_minutes', () => {
    expect(() =>
      buildTimeEntryInterval({ start: '2026-07-11T09:00:00Z', duration_minutes: '30' })
    ).toThrow(/positive number/);
  });

  it('rejects an invalid end datetime', () => {
    expect(() =>
      buildTimeEntryInterval({ start: '2026-07-11T09:00:00Z', end: 'nonsense' })
    ).toThrow(/Invalid end/);
  });

  it('rounds sub-second precision to whole seconds', () => {
    const interval = buildTimeEntryInterval({
      start: '2026-07-11T09:00:00.000Z',
      end: '2026-07-11T09:00:30.400Z',
    });

    expect(interval.duration).toBe(30);
  });

  it('trims surrounding whitespace on datetimes', () => {
    const interval = buildTimeEntryInterval({
      start: '  2026-07-11T09:00:00Z  ',
      duration_minutes: 10,
    });

    expect(interval.start).toBe('2026-07-11T09:00:00.000Z');
    expect(interval.stop).toBe('2026-07-11T09:10:00.000Z');
  });
});

describe('filterHydratedEntries', () => {
  const hydrated = (overrides: Partial<HydratedTimeEntry>): HydratedTimeEntry => ({
    id: 1,
    workspace_id: 100,
    workspace_name: 'Acme',
    start: '2026-07-10T09:00:00.000Z',
    duration: 3600,
    duration_seconds: 3600,
    running: false,
    tags: [],
    tag_ids: [],
    tag_names: [],
    ...overrides,
  });

  const entries: HydratedTimeEntry[] = [
    hydrated({
      id: 1,
      description: 'Write API docs',
      project_id: 10,
      project_name: 'Website',
      client_id: 500,
      client_name: 'Globex',
      start: '2026-07-10T09:00:00.000Z',
      duration_seconds: 1800,
      billable: true,
      tags: ['docs'],
      tag_names: ['docs'],
    }),
    hydrated({
      id: 2,
      description: 'Fix login bug',
      project_id: 11,
      project_name: 'Mobile App',
      client_id: 501,
      client_name: 'Initech',
      start: '2026-07-11T14:00:00.000Z',
      duration_seconds: 5400,
      billable: false,
      tags: ['bug', 'urgent'],
      tag_names: ['bug', 'urgent'],
    }),
    hydrated({
      id: 3,
      description: 'Standup meeting',
      workspace_id: 200,
      workspace_name: 'Side Projects',
      start: '2026-07-12T08:00:00.000Z',
      duration_seconds: 900,
    }),
  ];

  const ids = (result: HydratedTimeEntry[]) => result.map((entry) => entry.id);

  it('returns everything when no criteria are given', () => {
    expect(ids(filterHydratedEntries(entries, {}))).toEqual([1, 2, 3]);
  });

  it('matches description case-insensitively as a substring', () => {
    expect(ids(filterHydratedEntries(entries, { description: 'LOGIN' }))).toEqual([2]);
  });

  it('matches project and client names case-insensitively', () => {
    expect(ids(filterHydratedEntries(entries, { project_name: 'web' }))).toEqual([1]);
    expect(ids(filterHydratedEntries(entries, { client_name: 'initech' }))).toEqual([2]);
  });

  it('excludes entries without a project/client when those name filters are set', () => {
    expect(ids(filterHydratedEntries(entries, { project_name: 'app' }))).toEqual([2]);
    // 'e' appears in both "Globex" and "Initech"; entry 3 has no client so it is excluded.
    expect(ids(filterHydratedEntries(entries, { client_name: 'e' }))).toEqual([1, 2]);
  });

  it('matches exact ids for project, client, and workspace', () => {
    expect(ids(filterHydratedEntries(entries, { project_id: 10 }))).toEqual([1]);
    expect(ids(filterHydratedEntries(entries, { client_id: 501 }))).toEqual([2]);
    expect(ids(filterHydratedEntries(entries, { workspace_id: 200 }))).toEqual([3]);
  });

  it('filters by billable flag', () => {
    expect(ids(filterHydratedEntries(entries, { billable: true }))).toEqual([1]);
    expect(ids(filterHydratedEntries(entries, { billable: false }))).toEqual([2, 3]);
  });

  it('matches any tag case-insensitively', () => {
    expect(ids(filterHydratedEntries(entries, { tag: 'URGENT' }))).toEqual([2]);
    expect(ids(filterHydratedEntries(entries, { tag: 'missing' }))).toEqual([]);
  });

  it('filters by start_after and start_before (inclusive bounds)', () => {
    expect(ids(filterHydratedEntries(entries, { start_after: '2026-07-11T00:00:00Z' }))).toEqual([
      2, 3,
    ]);
    expect(ids(filterHydratedEntries(entries, { start_before: '2026-07-11T14:00:00Z' }))).toEqual([
      1, 2,
    ]);
    expect(
      ids(
        filterHydratedEntries(entries, {
          start_after: '2026-07-11T00:00:00Z',
          start_before: '2026-07-11T23:59:59Z',
        })
      )
    ).toEqual([2]);
  });

  it('filters by duration bounds in minutes', () => {
    // durations: id1=30m, id2=90m, id3=15m
    expect(ids(filterHydratedEntries(entries, { min_duration_minutes: 30 }))).toEqual([1, 2]);
    expect(ids(filterHydratedEntries(entries, { max_duration_minutes: 30 }))).toEqual([1, 3]);
    expect(
      ids(filterHydratedEntries(entries, { min_duration_minutes: 20, max_duration_minutes: 60 }))
    ).toEqual([1]);
  });

  it('combines multiple criteria with AND', () => {
    expect(
      ids(filterHydratedEntries(entries, { billable: false, min_duration_minutes: 60 }))
    ).toEqual([2]);
    expect(ids(filterHydratedEntries(entries, { project_name: 'web', billable: false }))).toEqual(
      []
    );
  });

  it('rejects invalid datetime and negative duration bounds', () => {
    expect(() => filterHydratedEntries(entries, { start_after: 'nope' })).toThrow(
      /Invalid start_after/
    );
    expect(() => filterHydratedEntries(entries, { min_duration_minutes: -5 })).toThrow(
      /min_duration_minutes must be a non-negative number/
    );
  });
});
