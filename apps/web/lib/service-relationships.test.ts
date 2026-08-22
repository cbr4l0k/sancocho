import { describe, expect, test } from 'bun:test';

import { mayRemoveServiceRelationship, relationshipTargetOptions } from '@/lib/service-relationships';

describe('mayRemoveServiceRelationship', () => {
  test('permits removal only for writable outgoing links', () => {
    expect(mayRemoveServiceRelationship('outgoing', true)).toBe(true);
    expect(mayRemoveServiceRelationship('incoming', true)).toBe(false);
    expect(mayRemoveServiceRelationship('outgoing', false)).toBe(false);
  });
});

describe('relationshipTargetOptions', () => {
  test('excludes the viewed service while preserving every other target', () => {
    const services = [
      { _id: 'service-a', name: 'Airport pickup' },
      { _id: 'service-b', name: 'Return transfer' },
      { _id: 'service-c', name: 'Hotel shuttle' },
    ];

    expect(relationshipTargetOptions(services, 'service-b')).toEqual([
      { _id: 'service-a', name: 'Airport pickup' },
      { _id: 'service-c', name: 'Hotel shuttle' },
    ]);
  });
});
