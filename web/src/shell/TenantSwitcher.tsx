import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import clsx from 'clsx'
import { Building2, Check, ChevronDown } from 'lucide-react'
import { focusOnDark, menuItemHighlight } from '../ui/focus'

export interface TenantOption {
  id: string
  name: string
}

export interface TenantSwitcherProps {
  tenants: TenantOption[]
  activeId: string | undefined
  /** Whether the session can switch to a tenant; defaults to no. */
  canSwitch?: (tenantId: string) => boolean
  onSwitch?: (tenantId: string) => void
}

/** Shows the active tenant; a menu when the user belongs to several. */
export function TenantSwitcher({ tenants, activeId, canSwitch, onSwitch }: TenantSwitcherProps) {
  const active = tenants.find((t) => t.id === activeId)
  if (tenants.length <= 1) {
    return (
      <span className="flex items-center gap-2 text-sm">
        <Building2 aria-hidden="true" size={16} />
        <span>
          <span className="sr-only">Tenant: </span>
          {active?.name ?? tenants[0]?.name ?? ''}
        </span>
      </span>
    )
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={clsx(
          'flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-white/10',
          focusOnDark,
        )}
      >
        <Building2 aria-hidden="true" size={16} />
        <span>
          <span className="sr-only">Tenant: </span>
          {active?.name ?? 'Select tenant'}
        </span>
        <ChevronDown aria-hidden="true" size={16} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-48 rounded-md border border-ink/20 bg-white p-1 text-ink shadow-lg"
        >
          <DropdownMenu.Label className="px-2 py-1 text-xs font-medium text-ink/80">
            Switch tenant
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={activeId} onValueChange={(id) => onSwitch?.(id)}>
            {tenants.map((t) => (
              <DropdownMenu.RadioItem
                key={t.id}
                value={t.id}
                disabled={t.id !== activeId && !canSwitch?.(t.id)}
                className={clsx(
                  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm data-[disabled]:opacity-50',
                  menuItemHighlight,
                )}
              >
                <span className="w-4">
                  <DropdownMenu.ItemIndicator>
                    <Check aria-hidden="true" size={14} />
                  </DropdownMenu.ItemIndicator>
                </span>
                {t.name}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
