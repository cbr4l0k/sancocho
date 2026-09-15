import { expect, test } from 'bun:test';

import { eventWindowProblem, formatEventWindow } from './event-window';
import { projectWindowProblem } from './project-window';

test('reports only the Event-specific start/end ordering problem', () => {
  expect(eventWindowProblem(200, 199)).toBe('endBeforeStart');
  expect(eventWindowProblem(200, 200)).toBeUndefined();
  expect(eventWindowProblem(200, undefined)).toBeUndefined();
});

test('formats an open Event window without an invented end', () => {
  const start = new Date(2026, 8, 15, 9, 0).getTime();
  expect(formatEventWindow('en-US', start, undefined)).not.toContain('–');
});

test('formats both dates when an Event spans a day boundary', () => {
  const start = new Date(2026, 8, 15, 23, 0).getTime();
  const end = new Date(2026, 8, 16, 1, 0).getTime();
  const formatted = formatEventWindow('en-US', start, end);
  expect(formatted).toContain('Sep 15');
  expect(formatted).toContain('Sep 16');
});

test('reuses the generic Project window rule for Events', () => {
  expect(projectWindowProblem({ startsAt: 100, endsAt: 300 }, 99, 200)).toBe('before');
  expect(projectWindowProblem({ startsAt: 100, endsAt: 300 }, 200, 301)).toBe('after');
});
