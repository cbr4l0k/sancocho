'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBody } from '@/components/ui/panel';
import { localeHref } from '@/i18n/locale-href';
import { LocaleLink } from '@/i18n/locale-link';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { roleAtLeast } from '@/lib/roles';
import { cn } from '@/lib/utils';

/**
 * Settings is where an organization is *configured*, as opposed to operated.
 *
 * Service kinds, locations and field definitions moved here from the top-level nav
 * because they are set up once by whoever administers the tenant and then left
 * alone — putting them beside Projects and Services implied a planner would open
 * them daily, and made the field editor look like an operational screen.
 *
 * `adminOnly` hides a section from members below admin. That is presentation
 * only and never an authorization decision (I1): every mutation behind these
 * screens re-checks the caller's role server-side, which is the check that
 * actually holds.
 */
const sections = [
  { to: '/settings', labelKey: 'settings.sections.organization', adminOnly: false },
  // Service kinds stay open to planners: composing a service kind from the existing field
  // vocabulary is planning work, and the server still requires `planner` for it.
  { to: '/settings/service-kinds', labelKey: 'settings.sections.serviceKinds', adminOnly: false },
  { to: '/settings/fields', labelKey: 'settings.sections.fields', adminOnly: true },
  { to: '/settings/locations', labelKey: 'settings.sections.locations', adminOnly: true },
  // Provider reads are open to organization members; the surface gates admin-only writes itself.
  { to: '/settings/providers', labelKey: 'settings.sections.providers', adminOnly: false },
  // Vehicle Class and Fleet Vehicle reads are open to members; the surface gates writes itself.
  { to: '/settings/fleet', labelKey: 'settings.sections.fleet', adminOnly: false },
] as const;

export function SettingsShell({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const pathname = usePathname();
  const { currentOrganization } = useCurrentOrganization();

  if (currentOrganization === null) return null;
  const isAdmin = roleAtLeast(currentOrganization.role, 'admin');

  // The longest matching section wins, so /settings/fields highlights Fields
  // rather than Organization, whose href is a prefix of every other section's.
  const active = sections
    .filter((section) => {
      const href = localeHref(locale, section.to);
      return pathname === href || pathname.startsWith(`${href}/`);
    })
    .sort((left, right) => right.to.length - left.to.length)[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
      <nav aria-label={t('settings.sectionsLabel')} className="min-w-0">
        <ul className="flex flex-row gap-1 overflow-x-auto lg:sticky lg:top-6 lg:flex-col">
          {sections
            .filter((section) => !section.adminOnly || isAdmin)
            .map((section) => (
              <li key={section.to} className="shrink-0 lg:shrink">
                <LocaleLink
                  to={section.to}
                  aria-current={section.to === active?.to ? 'page' : undefined}
                  className={cn(
                    'block rounded-input px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors duration-150',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    section.to === active?.to ? 'bg-ground-2 text-ink' : 'text-ink-2 hover:bg-ground-1 hover:text-ink',
                  )}
                >
                  {t(section.labelKey)}
                </LocaleLink>
              </li>
            ))}
        </ul>
      </nav>
      <div className="min-w-0">
        {active !== undefined && active.adminOnly && !isAdmin ? (
          <Panel>
            <PanelBody>
              <EmptyState title={t('settings.adminOnlyTitle')} description={t('settings.adminOnlyBody')} />
            </PanelBody>
          </Panel>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
