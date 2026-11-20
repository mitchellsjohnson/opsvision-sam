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
  KeyRound,
  List,
  LogOut,
  Menu,
  MessageCircleQuestion,
  PanelLeftClose,
  PanelLeftOpen,
  Tags,
  Upload,
  Users,
} from 'lucide-react'
import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { Link, NavLink, Outlet, useLocation, useMatch, useResolvedPath, useSearchParams } from 'react-router'
import { useMe, useScorecards } from '../api/queries'
import { useAuth } from '../auth/context'
import { AskSamProvider } from '../features/assistant/AskSamDrawer'
import { useAskSam, usePageAssistantContext } from '../features/assistant/useAssistant'
import { focusOnDark, menuItemHighlight } from '../ui/focus'
import { Sam } from '../ui/Sam'
import { NavDrawer } from './NavDrawer'
import { PeriodPicker } from './PeriodPicker'
import { TenantSwitcher } from './TenantSwitcher'
import { useDefaultScope } from './useDefaultScope'
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
  { to: '/admin/assistant', label: 'Ask SAM settings', icon: MessageCircleQuestion },
]

const NAV_LINKS_ID = 'main-nav-links'

/** Tailwind's `sm`: below it is a phone. Without matchMedia, assume a wider screen. */
const SM_UP = '(min-width: 640px)'

function subscribePhone(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(SM_UP)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function phoneSnapshot(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? !window.matchMedia(SM_UP).matches : false
}

/** The top bar is never sticky (it scrolls away), so sticky content below it offsets by nothing. */
const SHELL_ROOT_STYLE = { ['--top-bar-h' as string]: '0px' } as CSSProperties

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

/** Opens Ask SAM from the navigation; a button, since it opens the drawer rather than a page. */
function AskSamNavButton({ collapsed, onOpen }: { collapsed: boolean; onOpen?: () => void }) {
  const sam = useAskSam()
  const context = usePageAssistantContext()
  return (
    <RailTip label="Ask SAM" collapsed={collapsed}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={sam.isOpen}
        aria-label={collapsed ? 'Ask SAM' : undefined}
        onClick={onOpen ?? (() => sam.open(context))}
        className={clsx(itemClass(collapsed), 'text-ink hover:bg-white')}
      >
        <Sam className={navIconClass(collapsed)} />
        {!collapsed && <span>Ask SAM</span>}
      </button>
    </RailTip>
  )
}

/** The navigation's links: the rail (collapsed or expanded) and the phone drawer (expanded) both draw these. */
function NavList({
  scorecards,
  searchFor,
  isAdmin,
  collapsed,
  onAskSam,
}: {
  scorecards: { id: string; name: string }[]
  searchFor: (scorecardId?: string) => string
  isAdmin: boolean
  collapsed: boolean
  onAskSam?: () => void
}) {
  return (
    <>
      <ul className="space-y-1">
        {scorecards.map((sc) => (
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
        <li>
          <AskSamNavButton collapsed={collapsed} onOpen={onAskSam} />
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
    </>
  )
}

function AppShellBody() {
  const { open: dockOpen, dockRef } = useShellDock()
  const sam = useAskSam()
  const samContext = usePageAssistantContext()
  const auth = useAuth()
  const me = useMe()
  const scorecards = useScorecards()
  const location = useLocation()
  const { pathname } = location
  const [params] = useSearchParams()
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Any route change, or widening past a phone, closes the drawer.
  const [drawerRoute, setDrawerRoute] = useState(location.key)
  if (drawerRoute !== location.key) {
    setDrawerRoute(location.key)
    setDrawerOpen(false)
  }
  if (drawerOpen && !phone) setDrawerOpen(false)
  const openSamFromDrawer = () => {
    setDrawerOpen(false)
    // Once the drawer has gone, so SAM hands focus back to the menu button rather than a removed link.
    setTimeout(() => {
      menuButtonRef.current?.focus()
      sam.open(samContext)
    }, 0)
  }
  const [navCollapsed, toggleNav] = useNavCollapsed()
  // The open dock needs the room: the nav shows as the rail meanwhile.
  const collapsed = navCollapsed || dockOpen
  const toggleLabel = collapsed ? 'Expand navigation' : 'Collapse navigation'
  const settingsLabelId = useId()

  const isAdmin = me.data?.role === 'admin'
  const showFilters = pathname === '/entry'

  // Carry the period/YTD/subject selection between report pages. A
  // restatement names one scorecard's methodology version, so it stays behind
  // on links to anywhere else. Entering a scorecard from a page with no scope
  // opens it at the saved default scope; between scorecards the page's scope
  // (including the company) carries as it is.
  const currentScorecard = /^\/scorecards\/([^/]+)/.exec(pathname)?.[1]
  const defaultScope = useDefaultScope(params.get('period')).scope
  const searchFor = (scorecardId?: string) => {
    const carried = new URLSearchParams()
    for (const key of VIEW_PARAMS) {
      if (key === 'restate' && scorecardId !== currentScorecard) continue
      for (const v of params.getAll(key)) carried.append(key, v)
    }
    if (scorecardId && !currentScorecard && !carried.has('scope') && defaultScope) carried.set('scope', defaultScope)
    return carried.size > 0 ? `?${carried.toString()}` : ''
  }

  const tenant = me.data?.tenant
  const { rememberTenant } = auth
  useEffect(() => {
    // A single-organization tenant has no organization to switch back to.
    if (tenant?.auth0OrgId && rememberTenant) rememberTenant(tenant.id, tenant.auth0OrgId)
  }, [tenant, rememberTenant])

  const scorecardList = scorecards.data?.scorecards ?? []

  return (
    // Beside the page, SAM takes the right edge and the page reflows into the rest.
    <div style={SHELL_ROOT_STYLE} className={clsx('flex min-h-screen flex-col', sam.docked && 'lg:pr-[26rem]')}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:font-medium focus:text-accent-deep focus:outline-2 focus:outline-offset-2 focus:outline-amber"
      >
        Skip to main content
      </a>

      {/* At 320px the bar must fit without scrolling the page sideways: tighter gaps, and the account name truncates. */}
      <header className="flex items-center gap-2 bg-accent-deep px-3 py-2 text-white sm:gap-4 sm:px-4">
        {phone && (
          <button
            ref={menuButtonRef}
            type="button"
            aria-label="Open navigation"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className={clsx('-ml-1 flex size-10 shrink-0 items-center justify-center rounded-md hover:bg-white/10', focusOnDark)}
          >
            <Menu aria-hidden="true" className="size-5 shrink-0" />
          </button>
        )}
        <span className="shrink-0 text-lg font-semibold tracking-tight">OpsVision</span>
        <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-4">
          <button
            type="button"
            aria-label="Ask SAM"
            aria-haspopup="dialog"
            aria-expanded={sam.isOpen}
            onClick={() => sam.open(samContext)}
            className={clsx(
              'flex size-9 shrink-0 items-center justify-center rounded-full bg-white p-0.5 hover:ring-2 hover:ring-white/60',
              focusOnDark,
            )}
          >
            <Sam className="size-8" />
          </button>
          <TenantSwitcher
            tenants={me.data?.tenants ?? []}
            activeId={tenant?.id}
            canSwitch={auth.canSwitchTenant}
            onSwitch={auth.switchTenant}
            nameHidden={phone}
          />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              className={clsx(
                'flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-white/10',
                focusOnDark,
              )}
            >
              <span className="truncate whitespace-nowrap">{me.data?.name ?? 'Account'}</span>
              <ChevronDown aria-hidden="true" size={16} className="shrink-0" />
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
                    {phone && tenant?.name && <span className="block">{tenant.name}</span>}
                  </DropdownMenu.Label>
                )}
                <DropdownMenu.Separator className="my-1 h-px bg-ink/15" />
                <DropdownMenu.Group aria-labelledby={settingsLabelId}>
                  <DropdownMenu.Label
                    id={settingsLabelId}
                    className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink/80"
                  >
                    My settings
                  </DropdownMenu.Label>
                  <DropdownMenu.Item
                    asChild
                    className={clsx(
                      'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                      menuItemHighlight,
                    )}
                  >
                    <Link to="/settings/tokens">
                      <KeyRound aria-hidden="true" size={14} />
                      Access tokens
                    </Link>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    asChild
                    className={clsx(
                      'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                      menuItemHighlight,
                    )}
                  >
                    <Link to="/settings/ask-sam">
                      <MessageCircleQuestion aria-hidden="true" size={14} />
                      Ask SAM key
                    </Link>
                  </DropdownMenu.Item>
                </DropdownMenu.Group>
                <DropdownMenu.Separator className="my-1 h-px bg-ink/15" />
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

      {phone && (
        <NavDrawer open={drawerOpen} onOpenChange={setDrawerOpen} returnFocus={menuButtonRef}>
          <nav aria-label="Main" className="p-3">
            <NavList
              scorecards={scorecardList}
              searchFor={searchFor}
              isAdmin={isAdmin}
              collapsed={false}
              onAskSam={openSamFromDrawer}
            />
          </nav>
        </NavDrawer>
      )}

      <div
        className={clsx(
          'grid flex-1',
          phone ? 'grid-cols-[minmax(0,1fr)_auto]' : 'grid-cols-[auto_minmax(0,1fr)_auto]',
        )}
      >
        {!phone && (
          <nav
            aria-label="Main"
            className={clsx(
              'flex shrink-0 flex-col border-r border-ink/15 bg-cream/60 motion-safe:transition-[width]',
              collapsed ? 'w-16 p-3' : 'w-60 p-3',
            )}
          >
            <div id={NAV_LINKS_ID} className="flex-1">
              <NavList scorecards={scorecardList} searchFor={searchFor} isAdmin={isAdmin} collapsed={collapsed} />
            </div>
            <div
              data-nav-footer
              className={clsx(
                'sticky bottom-0 -mx-3 -mb-3 mt-3 flex border-t border-ink/15 bg-cream p-3',
                collapsed ? 'justify-center' : 'justify-end',
              )}
            >
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    aria-controls={NAV_LINKS_ID}
                    aria-label={toggleLabel}
                    onClick={toggleNav}
                    className="flex size-8 items-center justify-center rounded-md text-ink hover:bg-white"
                  >
                    {collapsed ? (
                      <PanelLeftOpen aria-hidden="true" className="size-4 shrink-0" />
                    ) : (
                      <PanelLeftClose aria-hidden="true" className="size-4 shrink-0" />
                    )}
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    side="right"
                    sideOffset={8}
                    className="z-50 rounded-md bg-ink px-2 py-1 text-xs font-medium text-white shadow-lg"
                  >
                    {toggleLabel}
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </div>
          </nav>
        )}

        <div className="min-w-0 flex-1">
          {showFilters && (
            <section
              aria-label="Report filters"
              className="flex flex-wrap items-end gap-4 border-b border-ink/15 bg-white px-4 py-3 sm:px-6"
            >
              <PeriodPicker monthOnly />
            </section>
          )}
          <main id="main" tabIndex={-1} className="min-w-0 p-4 outline-none sm:p-6">
            <Outlet />
          </main>
        </div>

        <aside
          ref={dockRef}
          aria-hidden={!dockOpen}
          className={clsx(
            'sticky top-0 max-h-screen shrink-0 self-start overflow-hidden bg-white transition-[width]',
            dockOpen ? 'w-96 overflow-y-auto border-l border-ink/15' : 'w-0',
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
        <AskSamProvider>
          <AppShellBody />
        </AskSamProvider>
      </ShellDockProvider>
    </Tooltip.Provider>
  )
}
