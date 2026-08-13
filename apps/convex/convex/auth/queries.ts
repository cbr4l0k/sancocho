import { v } from 'convex/values';

import { query } from '../_generated/server';
import { getUserForCurrentIdentity } from './model';

// Client-facing user shape: internal identity keys (authProvider/authSubject)
// stay server-side. The handler maps explicitly, so a schema change that
// matters here is a compile error, not silent drift.
const publicUserValidator = v.object({
  _id: v.id('users'),
  _creationTime: v.number(),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
});

export const getCurrentUser = query({
  args: {},
  returns: v.union(v.null(), publicUserValidator),
  handler: async (ctx) => {
    const user = await getUserForCurrentIdentity(ctx);
    if (user === null) {
      return null;
    }
    return {
      _id: user._id,
      _creationTime: user._creationTime,
      ...(user.name === undefined ? {} : { name: user.name }),
      ...(user.email === undefined ? {} : { email: user.email }),
    };
  },
});
