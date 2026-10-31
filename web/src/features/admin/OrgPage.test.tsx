import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { currentMonth } from '../../lib/period'
import { adminHandlers, newAdminFake, type AdminFake } from '../../test/adminFixtures'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { addMonths } from './adminModel'
import { OrgPage } from './OrgPage'

const NOW = currentMonth(1)
const FUTURE = addMonths(NOW, 3)

let fake: AdminFake

beforeEach(() => {
  fake = newAdminFake()
  server.use(...adminHandlers(fake))
})

async function setup() {
  const user = userEvent.setup()
  const view = renderApp(<OrgPage />)
  await screen.findByRole('list', { name: /^Org structure as of/ })
  return { user, ...view }
}

function treeList() {
  return screen.getByRole('list', { name: /^Org structure as of/ })
}

/** The names shown in the tree, depth first. */
function treeNames() {
  return within(treeList())
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-unit-name]')?.textContent)
}

function writes(method: string, path: string) {
  return fake.requests.filter((r) => r.method === method && r.path === path)
}

describe('OrgPage', () => {
  it('shows the levels, the current tree with level names, and retired units apart', async () => {
    await setup()
    expect(screen.getByRole('heading', { level: 1, name: 'Org structure' })).toBeTruthy()
    expect((screen.getByLabelText('Level 2 name') as HTMLInputElement).value).toBe('Segment')
    expect(treeNames()).toEqual(['Acme', 'Segment A', 'Product One', 'Segment B'])
    const productOne = within(treeList()).getByText('Product One').closest('li') as HTMLElement
    expect(within(productOne).getAllByText('Product').length).toBeGreaterThan(0)
    const retired = screen.getByRole('region', { name: 'Retired units' })
    expect(within(retired).getByText('Old Segment')).toBeTruthy()
    expect((screen.getByLabelText('Show structure as of') as HTMLSelectElement).value).toBe(NOW)
  })

  it('shows a load error', async () => {
    server.use(http.get(`${API}/v1/org/levels`, () => HttpResponse.json({ error: { code: 'internal', message: 'down' } }, { status: 500 })))
    renderApp(<OrgPage />)
    expect((await screen.findByText(/Could not load levels: down/)).getAttribute('role')).toBe('alert')
  })

  describe('levels', () => {
    it('renames a level and saves the whole list in depth order', async () => {
      const { user } = await setup()
      const name = screen.getByLabelText('Level 2 name')
      await user.clear(name)
      await user.type(name, 'Division')
      await user.click(screen.getByRole('button', { name: 'Save levels' }))
      await waitFor(() => expect(writes('PUT', '/org/levels')).toHaveLength(1))
      expect(writes('PUT', '/org/levels')[0]?.body).toEqual({
        levels: [
          { id: 'company', name: 'Company', depth: 0 },
          { id: 'segment', name: 'Division', depth: 1 },
          { id: 'product', name: 'Product', depth: 2 },
        ],
      })
      // The tree now shows the new level name.
      expect((await within(treeList()).findAllByText('Division')).length).toBeGreaterThan(0)
      expect(screen.getByRole('status').textContent).toContain('Levels saved')
    })

    it('reorders levels and adds one with an ID taken from its name', async () => {
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Move Product level up' }))
      await user.click(screen.getByRole('button', { name: 'Add level' }))
      await user.type(screen.getByLabelText('Level 4 name'), 'Sub Team')
      expect((screen.getByLabelText('Level 4 ID') as HTMLInputElement).value).toBe('sub-team')
      await user.click(screen.getByRole('button', { name: 'Save levels' }))
      await waitFor(() => expect(writes('PUT', '/org/levels')).toHaveLength(1))
      expect(writes('PUT', '/org/levels')[0]?.body).toEqual({
        levels: [
          { id: 'company', name: 'Company', depth: 0 },
          { id: 'product', name: 'Product', depth: 1 },
          { id: 'segment', name: 'Segment', depth: 2 },
          { id: 'sub-team', name: 'Sub Team', depth: 3 },
        ],
      })
    })

    it('shows API 400 details inline at the row they belong to and moves focus to the first', async () => {
      fake.failNext.set('PUT /org/levels', {
        status: 400,
        code: 'invalid',
        message: 'request validation failed',
        details: [
          { path: 'levels[1].name', message: 'must not be empty' },
          { path: 'levels', message: 'org unit prod-1 (level product, depth 2) must be deeper than its parent seg-a' },
        ],
      })
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Save levels' }))
      const name = screen.getByLabelText('Level 2 name')
      await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'))
      const described = (name.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' ')
      expect(described).toContain('must not be empty')
      expect(screen.getByText(/must be deeper than its parent seg-a/)).toBeTruthy()
      await waitFor(() => expect(document.activeElement).toBe(name))
      // Other rows are not marked invalid.
      expect(screen.getByLabelText('Level 1 name').getAttribute('aria-invalid')).toBeNull()
    })

    it('shows a 409 from removing a level that units still use', async () => {
      fake.failNext.set('PUT /org/levels', {
        status: 409,
        code: 'conflict',
        message: 'level product is still used by org unit prod-1',
      })
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Remove Product level' }))
      await user.click(screen.getByRole('button', { name: 'Save levels' }))
      expect((await screen.findByText('level product is still used by org unit prod-1')).closest('[role="alert"]')).toBeTruthy()
    })
  })

  describe('tree', () => {
    it('adds a unit with an ID suggested from its name, which can be edited', async () => {
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Add unit' }))
      const dialog = screen.getByRole('dialog', { name: 'Add unit' })
      await user.type(within(dialog).getByLabelText('Name'), 'Platform Team')
      const id = within(dialog).getByLabelText('ID') as HTMLInputElement
      expect(id.value).toBe('platform-team')
      await user.clear(id)
      await user.type(id, 'plat')
      // Editing the ID stops it following the name.
      await user.type(within(dialog).getByLabelText('Name'), ' X')
      expect(id.value).toBe('plat')
      await user.selectOptions(within(dialog).getByLabelText('Level'), 'segment')
      await user.selectOptions(within(dialog).getByLabelText('Parent'), 'acme')
      await user.type(within(dialog).getByLabelText('Source keys'), 'plat, platform ,, plat-x')
      await user.click(within(dialog).getByRole('button', { name: 'Add unit' }))
      await waitFor(() => expect(writes('POST', '/org/units')).toHaveLength(1))
      expect(writes('POST', '/org/units')[0]?.body).toEqual({
        id: 'plat',
        name: 'Platform Team X',
        levelId: 'segment',
        parentId: 'acme',
        sourceKeys: ['plat', 'platform', 'plat-x'],
      })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(treeNames()).toContain('Platform Team X')
    })

    it('validates a new unit before sending it and focuses the first problem', async () => {
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Add unit' }))
      const dialog = screen.getByRole('dialog', { name: 'Add unit' })
      await user.click(within(dialog).getByRole('button', { name: 'Add unit' }))
      const name = within(dialog).getByLabelText('Name')
      expect(name.getAttribute('aria-invalid')).toBe('true')
      expect(document.activeElement).toBe(name)
      expect(within(dialog).getByText(/Enter a name/)).toBeTruthy()
      expect(writes('POST', '/org/units')).toHaveLength(0)
    })

    it('shows a 409 for a duplicate ID at the ID field', async () => {
      fake.failNext.set('POST /org/units', { status: 409, code: 'conflict', message: 'org unit acme already exists' })
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Add unit' }))
      const dialog = screen.getByRole('dialog', { name: 'Add unit' })
      await user.type(within(dialog).getByLabelText('Name'), 'Acme')
      await user.selectOptions(within(dialog).getByLabelText('Level'), 'company')
      await user.click(within(dialog).getByRole('button', { name: 'Add unit' }))
      const id = within(dialog).getByLabelText('ID')
      await waitFor(() => expect(id.getAttribute('aria-invalid')).toBe('true'))
      expect(within(dialog).getByText('org unit acme already exists')).toBeTruthy()
    })

    it('edits a unit: sends only what changed, with source keys parsed from the comma-separated input', async () => {
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Edit Segment A' }))
      const dialog = screen.getByRole('dialog', { name: 'Edit Segment A' })
      expect((within(dialog).getByLabelText('Source keys') as HTMLInputElement).value).toBe('seg a')
      const keys = within(dialog).getByLabelText('Source keys')
      await user.clear(keys)
      await user.type(keys, ' seg a , Alpha,, beta ')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(writes('PATCH', '/org/units/seg-a')).toHaveLength(1))
      expect(writes('PATCH', '/org/units/seg-a')[0]?.body).toEqual({ sourceKeys: ['seg a', 'Alpha', 'beta'] })
    })

    it('renames a unit and changes its level', async () => {
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Edit Segment B' }))
      const dialog = screen.getByRole('dialog', { name: 'Edit Segment B' })
      const name = within(dialog).getByLabelText('Name')
      await user.clear(name)
      await user.type(name, 'Segment Beta')
      await user.selectOptions(within(dialog).getByLabelText('Level'), 'product')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(writes('PATCH', '/org/units/seg-b')).toHaveLength(1))
      expect(writes('PATCH', '/org/units/seg-b')[0]?.body).toEqual({ name: 'Segment Beta', levelId: 'product' })
      await waitFor(() => expect(treeNames()).toContain('Segment Beta'))
    })

    it('maps a source key collision and a level depth error onto their fields', async () => {
      fake.failNext.set('PATCH /org/units/seg-b', {
        status: 400,
        code: 'invalid',
        message: 'request validation failed',
        details: [
          { path: 'sourceKeys[1]', message: 'source key "seg a" is already used by org unit seg-a' },
          { path: 'levelId', message: 'org unit seg-b (level product, depth 2) must be deeper than its parent acme' },
        ],
      })
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Edit Segment B' }))
      const dialog = screen.getByRole('dialog', { name: 'Edit Segment B' })
      await user.type(within(dialog).getByLabelText('Source keys'), 'x, seg a')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      const keys = within(dialog).getByLabelText('Source keys')
      await waitFor(() => expect(keys.getAttribute('aria-invalid')).toBe('true'))
      const text = (el: HTMLElement) =>
        (el.getAttribute('aria-describedby') ?? '')
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
      expect(text(keys)).toContain('is already used by org unit seg-a')
      // The level field is not changed, but its server message still shows beside it.
      expect(text(within(dialog).getByLabelText('Level'))).toContain('must be deeper than its parent acme')
      // Focus goes to the first invalid field in page order: the level comes before the keys.
      expect(document.activeElement).toBe(within(dialog).getByLabelText('Level'))
    })

    it('retires a unit from a month and drops it from the tree', async () => {
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Retire Segment B' }))
      const dialog = screen.getByRole('dialog', { name: 'Retire Segment B' })
      await user.selectOptions(within(dialog).getByLabelText('Retire from'), NOW)
      await user.click(within(dialog).getByRole('button', { name: 'Retire unit' }))
      await waitFor(() => expect(writes('PATCH', '/org/units/seg-b')).toHaveLength(1))
      expect(writes('PATCH', '/org/units/seg-b')[0]?.body).toEqual({ retiredFrom: NOW })
      await waitFor(() => expect(treeNames()).not.toContain('Segment B'))
      expect(within(screen.getByRole('region', { name: 'Retired units' })).getByText('Segment B')).toBeTruthy()
    })

    it('shows the API reason a unit with children cannot be retired, next to the month', async () => {
      fake.failNext.set('PATCH /org/units/seg-a', {
        status: 400,
        code: 'invalid',
        message: 'move or retire child units first',
      })
      const { user } = await setup()
      await user.click(screen.getByRole('button', { name: 'Retire Segment A' }))
      const dialog = screen.getByRole('dialog', { name: 'Retire Segment A' })
      await user.click(within(dialog).getByRole('button', { name: 'Retire unit' }))
      const month = within(dialog).getByLabelText('Retire from')
      await waitFor(() => expect(month.getAttribute('aria-invalid')).toBe('true'))
      expect(within(dialog).getByText('move or retire child units first')).toBeTruthy()
      expect(document.activeElement).toBe(month)
      // The dialog stays open so the person can pick another month or cancel.
      expect(screen.getByRole('dialog', { name: 'Retire Segment A' })).toBeTruthy()
    })
  })

  describe('move', () => {
    async function openMove(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: 'Move Product One' }))
      return screen.getByRole('dialog', { name: 'Move Product One' })
    }

    it('previews the resulting tree for the effective month and posts the move', async () => {
      const { user } = await setup()
      const dialog = await openMove(user)
      // Only units at a shallower level than the unit are offered, never the unit itself.
      const parent = within(dialog).getByLabelText('New parent') as HTMLSelectElement
      expect([...parent.options].map((o) => o.value)).toEqual(['', 'acme', 'seg-a', 'seg-b'])
      await user.selectOptions(parent, 'seg-b')
      await user.selectOptions(within(dialog).getByLabelText('Effective month'), FUTURE)
      const preview = await within(dialog).findByRole('region', { name: /^Preview/ })
      await waitFor(() => {
        const names = within(preview)
          .getAllByRole('listitem')
          .map((li) => li.querySelector('[data-unit-name]')?.textContent)
        expect(names).toEqual(['Acme', 'Segment A', 'Segment B', 'Product One'])
      })
      // The moved unit is marked in text, not only by style.
      expect(within(preview).getByText('Product One').closest('li')?.textContent).toContain('moved')
      await user.click(within(dialog).getByRole('button', { name: 'Move unit' }))
      await waitFor(() => expect(writes('POST', '/org/units/prod-1/moves')).toHaveLength(1))
      expect(writes('POST', '/org/units/prod-1/moves')[0]?.body).toEqual({
        newParentId: 'seg-b',
        effectiveMonth: FUTURE,
      })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.getByRole('status').textContent).toContain('Moved Product One under Segment B')
    })

    it('reflects the move in the tree only from its effective month when the as-of month is changed', async () => {
      const { user } = await setup()
      const dialog = await openMove(user)
      await user.selectOptions(within(dialog).getByLabelText('New parent'), 'seg-b')
      await user.selectOptions(within(dialog).getByLabelText('Effective month'), FUTURE)
      await user.click(within(dialog).getByRole('button', { name: 'Move unit' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      // The current month still has the old structure.
      expect(treeNames()).toEqual(['Acme', 'Segment A', 'Product One', 'Segment B'])
      await user.selectOptions(screen.getByLabelText('Show structure as of'), FUTURE)
      await waitFor(() => expect(treeNames()).toEqual(['Acme', 'Segment A', 'Segment B', 'Product One']))
      await user.selectOptions(screen.getByLabelText('Show structure as of'), NOW)
      await waitFor(() => expect(treeNames()).toEqual(['Acme', 'Segment A', 'Product One', 'Segment B']))
    })

    it('asks for a parent before posting', async () => {
      const { user } = await setup()
      const dialog = await openMove(user)
      await user.click(within(dialog).getByRole('button', { name: 'Move unit' }))
      const parent = within(dialog).getByLabelText('New parent')
      expect(parent.getAttribute('aria-invalid')).toBe('true')
      expect(document.activeElement).toBe(parent)
      expect(writes('POST', '/org/units/prod-1/moves')).toHaveLength(0)
    })

    it('shows an API error about the new parent next to that field', async () => {
      fake.failNext.set('POST /org/units/prod-1/moves', {
        status: 400,
        code: 'invalid',
        message: 'new parent is not at a shallower level',
        details: [{ path: 'newParentId', message: 'org unit prod-1 must be deeper than its parent seg-b' }],
      })
      const { user } = await setup()
      const dialog = await openMove(user)
      await user.selectOptions(within(dialog).getByLabelText('New parent'), 'seg-b')
      await user.click(within(dialog).getByRole('button', { name: 'Move unit' }))
      const parent = within(dialog).getByLabelText('New parent')
      await waitFor(() => expect(parent.getAttribute('aria-invalid')).toBe('true'))
      expect(within(dialog).getByText(/must be deeper than its parent seg-b/)).toBeTruthy()
    })

    it('shows a 409 for a second move in the same month at the month field', async () => {
      fake.failNext.set('POST /org/units/prod-1/moves', {
        status: 409,
        code: 'conflict',
        message: 'org unit prod-1 already has a move effective ' + NOW,
      })
      const { user } = await setup()
      const dialog = await openMove(user)
      await user.selectOptions(within(dialog).getByLabelText('New parent'), 'seg-b')
      await user.click(within(dialog).getByRole('button', { name: 'Move unit' }))
      const month = within(dialog).getByLabelText('Effective month')
      await waitFor(() => expect(month.getAttribute('aria-invalid')).toBe('true'))
      expect(within(dialog).getByText(/already has a move effective/)).toBeTruthy()
    })
  })

  describe('accessibility', () => {
    it('has no axe violations on the page', async () => {
      const { container } = await setup()
      expect((await axe(container)).violations).toEqual([])
    })

    it('has no axe violations in the add, edit, retire and move dialogs, and moves focus in and back', async () => {
      const { user } = await setup()
      for (const [open, title] of [
        ['Add unit', 'Add unit'],
        ['Edit Segment A', 'Edit Segment A'],
        ['Retire Segment A', 'Retire Segment A'],
        ['Move Product One', 'Move Product One'],
      ] as const) {
        const trigger = screen.getByRole('button', { name: open })
        await user.click(trigger)
        const dialog = await screen.findByRole('dialog', { name: title })
        expect(dialog.contains(document.activeElement)).toBe(true)
        expect((await axe(dialog)).violations).toEqual([])
        await user.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(document.activeElement).toBe(trigger)
      }
    })

    it('has no axe violations with errors showing', async () => {
      fake.failNext.set('PUT /org/levels', {
        status: 400,
        code: 'invalid',
        message: 'request validation failed',
        details: [{ path: 'levels[0].name', message: 'must not be empty' }],
      })
      const { user, container } = await setup()
      await user.click(screen.getByRole('button', { name: 'Save levels' }))
      await screen.findByText(/must not be empty/)
      expect((await axe(container)).violations).toEqual([])
    })
  })
})
