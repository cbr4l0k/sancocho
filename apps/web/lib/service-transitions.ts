import type { ServiceStatus } from '@/lib/status';

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
} as const satisfies Record<ServiceStatus, readonly ServiceStatus[]>;

export function legalNextServiceStatuses(status: ServiceStatus): readonly ServiceStatus[] {
  return nextStatuses[status];
}
