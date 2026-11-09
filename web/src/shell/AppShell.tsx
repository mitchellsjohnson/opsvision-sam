import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import clsx from 'clsx'
import { ChevronDown, LogOut } from 'lucide-react'
import { useEffect } from 'react'
import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router'
import { useMe, useOrgUnits, useScorecards } from '../api/queries'
import { useAuth } from '../auth/context'
import { focusOnDark, menuItemHighlight } from '../ui/focus'
import { Sam } from '../ui/Sam'
import { PeriodPicker } from './PeriodPicker'
import { SubjectFilter } from './SubjectFilter'
import { TenantSwitcher } from './TenantSwitcher'
import { VIEW_PARAMS } from './usePeriodState'

const ADMIN_LINKS = [
  { to: '/admin/org', label: 'Org' },
  { to: '/admin/items', label: 'Items' },
  { to: '/admin/members', label: 'Members' },
  { to: '/admin/methodology', label: 'Methodology' },
  { to: '/admin/import', label: 'Import' },
  { to: '/admin/record-types', label: 'Record types' },
  { to: '/admin/templates', label: 'Templates' },
]

function navClass({ isActive }: { isActive: boolean }) {
  return clsx(
    'block rounded-md px-3 py-2 text-sm font-medium',
    isActive ? 'bg-accent text-white' : 'text-ink hover:bg-white',
  )
}

export function AppShell() {
  const auth = useAuth()
  const me = useMe()
  const scorecards = useScorecards()
  const orgUnits = useOrgUnits()
  const { pathname } = useLocation()
  const [params] = useSearchParams()

  const isAdmin = me.data?.role === 'admin'
  const showFilters = pathname.startsWith('/scorecards') || pathname === '/entry'

  // Carry the period/YTD/subject selection between report pages.
  const carried = new URLSearchParams()
  for (const key of VIEW_PARAMS) for (const v of params.getAll(key)) carried.append(key, v)
  const search = carried.size > 0 ? `?${carried.toString()}` : ''

  const tenant = me.data?.tenant
  const { rememberTenant } = auth
  useEffect(() => {
    if (tenant && rememberTenant) rememberTenant(tenant.id, tenant.auth0OrgId)
  }, [tenant, rememberTenant])

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:font-medium focus:text-accent-deep focus:outline-2 focus:outline-offset-2 focus:outline-amber"
      >
        Skip to main content
      </a>

      <header className="flex items-center gap-4 bg-accent-deep px-4 py-2 text-white">
        <span className="text-lg font-semibold tracking-tight">OpsVision</span>
        <div className="ml-auto flex items-center gap-4">
          <button
            type="button"
            disabled
            aria-label="Ask SAM (coming soon)"
            className={clsx('flex size-9 items-center justify-center rounded-full bg-white p-0.5 opacity-80', focusOnDark)}
          >
            <Sam className="size-8" />
          </button>
          <TenantSwitcher
            tenants={me.data?.tenants ?? []}
            activeId={tenant?.id}
            canSwitch={auth.canSwitchTenant}
            onSwitch={auth.switchTenant}
          />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              className={clsx(
                'flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-white/10',
                focusOnDark,
              )}
            >
              {me.data?.name ?? 'Account'}
              <ChevronDown aria-hidden="true" size={16} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="z-50 min-w-48 rounded-md border border-ink/20 bg-white p-1 text-ink shadow-lg"
              >
                {me.data && (
                  <DropdownMenu.Label className="px-2 py-1 text-xs text-ink/80">
                    {me.data.email}
                    {me.data.role ? ` · ${me.data.role}` : ''}
                  </DropdownMenu.Label>
                )}
                <DropdownMenu.Item
                  onSelect={() => auth.signOut()}
                  className={clsx(
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                    menuItemHighlight,
                  )}
                >
                  <LogOut aria-hidden="true" size={14} />
                  Sign out
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      <div className="flex flex-1">
        <nav aria-label="Main" className="w-56 shrink-0 border-r border-ink/15 bg-cream/60 p-3">
          <ul className="space-y-1">
            {(scorecards.data?.scorecards ?? []).map((sc) => (
              <li key={sc.id}>
                <NavLink to={{ pathname: `/scorecards/${sc.id}`, search }} className={navClass}>
                  {sc.name}
                </NavLink>
              </li>
            ))}
            <li>
              <NavLink to={{ pathname: '/entry', search }} className={navClass}>
                Enter data
              </NavLink>
            </li>
          </ul>
          {isAdmin && (
            <>
              <p id="admin-nav" className="mt-6 px-3 text-xs font-semibold uppercase tracking-wide text-ink/80">
                Admin
              </p>
              <ul aria-labelledby="admin-nav" className="mt-1 space-y-1">
                {ADMIN_LINKS.map((l) => (
                  <li key={l.to}>
                    <NavLink to={l.to} className={navClass}>
                      {l.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </>
          )}
        </nav>

        <div className="min-w-0 flex-1">
          {showFilters && (
            <section
              aria-label="Report filters"
              className="flex flex-wrap items-end gap-4 border-b border-ink/15 bg-white px-6 py-3"
            >
              {pathname === '/entry' ? (
                <PeriodPicker monthOnly />
              ) : (
                <>
                  <PeriodPicker />
                  <SubjectFilter subjects={orgUnits.data?.units} />
                </>
              )}
            </section>
          )}
          <main id="main" tabIndex={-1} className="p-6 outline-none">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}
