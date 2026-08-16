import { describe, expect, test } from 'bun:test';

import { serviceFieldProblem } from './service-form-checks';

describe('service field checks', () => {
  test('permits an empty required field when the snapshot has a default', () => {
    expect(serviceFieldProblem({ kind: 'text' }, undefined, true, true)).toBeUndefined();
    expect(serviceFieldProblem({ kind: 'text' }, undefined, true, false)).toBe('required');
  });

  test('mirrors select membership and number rules for fast feedback', () => {
    expect(
      serviceFieldProblem(
        { kind: 'select', options: [{ id: 'go', label: 'Go' }] },
        { kind: 'select', optionId: 'stop' },
        false,
        false,
      ),
    ).toBe('invalid');
    expect(
      serviceFieldProblem({ kind: 'number', min: 2, integer: true }, { kind: 'number', value: 2.5 }, false, false),
    ).toBe('invalid');
  });
});
