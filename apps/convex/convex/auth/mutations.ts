import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { ensureAuthenticatedUser } from './model';

export const ensureUser = mutation({
  args: {},
  returns: v.id('users'),
  handler: async (ctx) => ensureAuthenticatedUser(ctx),
});
