'use client';

import { useTranslations } from 'next-intl';

/**
 * The in-flight indicator. `docs/web-design.md` §9 caps the entire system at
 * two animations, `sc-sweep` and `sc-breathe`; this reuses `sc-breathe` — the
 * same halo already used for an in-progress status marker — rather than
 * introducing a third (a bouncing-dots typing animation, say).
 */
export function ChatInFlightIndicator() {
  const t = useTranslations();

  return (
    <div className="flex items-center gap-2 px-1 text-xs text-ink-3" role="status" aria-live="polite">
      <span aria-hidden="true" className="relative block size-1.5 shrink-0 rounded-full bg-ink-3">
        <span className="absolute inset-0 rounded-full bg-ink-3 [animation:sc-breathe_2.6s_ease-in-out_infinite]" />
      </span>
      {t('chat.inFlight')}
    </div>
  );
}
