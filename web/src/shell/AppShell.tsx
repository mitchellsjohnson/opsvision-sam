import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import clsx from 'clsx'
import { ShellDockProvider, useShellDock } from './ShellDock'
import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  BookOpen,
  Building2,
  ChevronDown,
  ClipboardPen,
  FileText,
  List,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Tags,
  Upload,
  Users,
} from 'lucide-react'
import { useEffect, type ReactElement } from 'react'
import { NavLink, Outlet, useLocation, useMatch, useResolvedPath, useSearchParams } from 'react-router'
import { useMe, useScorecards } from '../api/queries'
import { useAuth } from '../auth/context'
import { focusOnDark, menuItemHighlight } from '../ui/focus'
import { Sam } from '../ui/Sam'
import { PeriodPicker } from './PeriodPicker'
import { TenantSwitcher } from './TenantSwitcher'
import { useNavCollapsed } from './useNavCollapsed'
import { VIEW_PARAMS } from './usePeriodState'

const ADMIN_LINKS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/admin/org', label: 'Org', icon: Building2 },
  { to: '/admin/items', label: 'Items', icon: List },
  { to: '/admin/members', label: 'Members', icon: Users },
  { to: '/admin/methodology', label: 'Methodology', icon: BookOpen },
  { to: '/admin/import', label: 'Import', icon: Upload },
  { to: '/admin/record-types', label: 'Record types', icon: Tags },
  { to: '/admin/templates', label: 'Templates', icon: FileText },
]

const NAV_LINKS_ID = 'main-nav-links'

function itemClass(collapsed: boolean) {
  return clsx(
    'rounded-md text-sm font-medium',
    collapsed ? 'flex size-10 items-center justify-center' : 'inline-flex w-full items-center gap-2 px-3 py-2',
  )
}

function navIconClass(collapsed: boolean) {
  return collapsed ? 'size-5 shrink-0' : 'size-4 shrink-0'
}

/** A tooltip that only shows while the nav is a rail; it opens on keyboard focus as well as hover. */
function RailTip({ label, collapsed, children }: { label: string; collapsed: boolean; children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      {collapsed && (
        <Tooltip.Portal>
          <Tooltip.Content
            side="right"
            sideOffset={8}
            className="z-50 rounded-md bg-ink px-2 py-1 text-xs font-medium text-white shadow-lg"
          >
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      )}
    </Tooltip.Root>
  )
}

function ShellNavLink({
  to,
  label,
  icon: Icon,
  collapsed,
}: {
  to: { pathname: string; search?: string } | string
  label: string
  icon: LucideIcon
  collapsed: boolean
}) {
  // The tooltip trigger's Slot joins class names as strings, so NavLink's
  // className callback would arrive as its source text: match here instead.
  const { pathname } = useResolvedPath(to)
  const isActive = useMatch({ path: pathname, end: false }) !== null
  return (
    <RailTip label={label} collapsed={collapsed}>
      <NavLink
        to={to}
        className={clsx(itemClass(collapsed), isActive ? 'bg-accent text-white' : 'text-ink hover:bg-white')}
        aria-label={collapsed ? label : undefined}
      >
        <Icon aria-hidden="true" className={navIconClass(collapsed)} />
        {!collapsed && <span>{label}</span>}
      </NavLink>
    </RailTip>
  )
}

function AppShellBody() {
  const { open: dockOpen, dockRef } = useShellDock()
  const auth = useAuth()
  const me = useMe()
  const scorecards = useScorecards()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const [navCollapsed, toggleNav] = useNavCollapsed()
  // The open dock needs the room: the nav shows as the rail meanwhile.
  const collapsed = navCollapsed || dockOpen

  const isAdmin = me.data?.role === 'admin'
  const showFilters = pathname === '/entry'

  // Carry the period/YTD/subject selection between report pages. A
  // restatement names one scorecard's methodology version, so it stays behind
  // on links to anywhere else.
  const currentScorecard = /^\/scorecards\/([^/]+)/.exec(pathname)?.[1]
  const searchFor = (scorecardId?: string) => {
    const carried = new URLSearchParams()
    for (const key of VIEW_PARAMS) {
      if (key === 'restate' && scorecardId !== currentScorecard) continue
      for (const v of params.getAll(key)) carried.append(key, v)
    }
    return carried.size > 0 ? `?${carried.toString()}` : ''
  }

  const tenant = me.data?.tenant
  const { rememberTenant } = auth
  useEffect(() => {
    // A single-organization tenant has no organization to switch back to.
    if (tenant?.auth0OrgId && rememberTenant) rememberTenant(tenant.id, tenant.auth0OrgId)
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

      <div className="grid flex-1 grid-cols-[auto_minmax(0,1fr)_auto]">
        <nav
          aria-label="Main"
          className={clsx(
            'shrink-0 border-r border-ink/15 bg-cream/60 motion-safe:transition-[width]',
            collapsed ? 'w-16 p-3' : 'w-60 p-3',
          )}
        >
          <RailTip label={collapsed ? 'Expand navigation' : 'Collapse navigation'} collapsed={collapsed}>
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-controls={NAV_LINKS_ID}
              aria-label={collapsed ? 'Expand navigation' : undefined}
              onClick={toggleNav}
              className={clsx(itemClass(collapsed), 'mb-2 text-ink hover:bg-white')}
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden="true" className={navIconClass(collapsed)} />
              ) : (
                <PanelLeftClose aria-hidden="true" className={navIconClass(collapsed)} />
              )}
              {!collapsed && <span>Collapse navigation</span>}
            </button>
          </RailTip>
          <div id={NAV_LINKS_ID}>
            <ul className="space-y-1">
              {(scorecards.data?.scorecards ?? []).map((sc) => (
                <li key={sc.id}>
                  <ShellNavLink
                    to={{ pathname: `/scorecards/${sc.id}/overview`, search: searchFor(sc.id) }}
                    label={sc.name}
                    icon={BarChart3}
                    collapsed={collapsed}
                  />
                </li>
              ))}
              <li>
                <ShellNavLink
                  to={{ pathname: '/entry', search: searchFor() }}
                  label="Enter data"
                  icon={ClipboardPen}
                  collapsed={collapsed}
                />
              </li>
            </ul>
            {isAdmin && (
              <>
                <p
                  id="admin-nav"
                  className={clsx(
                    'mt-6 px-3 text-xs font-semibold uppercase tracking-wide text-ink/80',
                    collapsed && 'sr-only',
                  )}
                >
                  Admin
                </p>
                <ul
                  aria-labelledby="admin-nav"
                  className={clsx('space-y-1', collapsed ? 'mt-3 border-t border-ink/15 pt-3' : 'mt-1')}
                >
                  {ADMIN_LINKS.map((l) => (
                    <li key={l.to}>
                      <ShellNavLink to={l.to} label={l.label} icon={l.icon} collapsed={collapsed} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </nav>

        <div className="min-w-0 flex-1">
          {showFilters && (
            <section
              aria-label="Report filters"
              className="flex flex-wrap items-end gap-4 border-b border-ink/15 bg-white px-6 py-3"
            >
              <PeriodPicker monthOnly />
            </section>
          )}
          <main id="main" tabIndex={-1} className="min-w-0 p-6 outline-none">
            <Outlet />
          </main>
        </div>

        <aside
          ref={dockRef}
          aria-hidden={!dockOpen}
          className={clsx(
            'sticky top-0 max-h-screen shrink-0 self-start overflow-hidden border-l border-ink/15 bg-white transition-[width]',
            dockOpen ? 'w-96 overflow-y-auto' : 'w-0',
          )}
        />
      </div>
    </div>
  )
}

export function AppShell() {
  return (
    <Tooltip.Provider delayDuration={300}>
      <ShellDockProvider>
        <AppShellBody />
      </ShellDockProvider>
    </Tooltip.Provider>
  )
}
