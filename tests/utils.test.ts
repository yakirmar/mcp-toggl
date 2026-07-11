process.env.TZ = 'Europe/London';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTimeEntryInterval,
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
