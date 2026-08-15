import type { EventStatus } from '@/lib/status';

/**
 * The client affordance mirrors the backend's one-step lifecycle. `Record` is
 * intentional: adding a backend status leaves this map uncompilable until its
 * legal next steps are decided.
 */
const nextStatuses = {
  draft: ['planned', 'cancelled'],
  planned: ['confirmed', 'cancelled'],
  confirmed: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
} as const satisfies Record<EventStatus, readonly EventStatus[]>;

export function legalNextServiceStatuses(status: EventStatus): readonly EventStatus[] {
  return nextStatuses[status];
}
