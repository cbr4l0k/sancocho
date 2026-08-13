import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import schema from '../convex/schema';
import { modules } from './helpers';

test('convex-test starts an isolated Convex runtime', async () => {
  const t = convexTest(schema, modules);

  await t.run(async (ctx) => {
    expect(ctx.db).toBeDefined();
  });
});
