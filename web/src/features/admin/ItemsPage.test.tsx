import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { adminHandlers, newAdminFake, type AdminFake } from '../../test/adminFixtures'
import { API, server } from '../../test/server'
import { renderApp } from '../../test/utils'
import { ItemsPage } from './ItemsPage'

let fake: AdminFake

beforeEach(() => {
  fake = newAdminFake()
  server.use(...adminHandlers(fake))
})

async function setup() {
  const user = userEvent.setup()
  const view = renderApp(<ItemsPage />)
  await screen.findByRole('table', { name: 'Service items' })
  return { user, ...view }
}

function writes(method: string, path: string) {
  return fake.requests.filter((r) => r.method === method && r.path === path)
}

function describedText(el: HTMLElement) {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

describe('ItemsPage', () => {
  it('lists kinds, and the items of each kind with their org unit and source keys', async () => {
    await setup()
    expect(screen.getByRole('heading', { level: 1, name: 'Items' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Service' })).toBeTruthy()
    const services = screen.getByRole('table', { name: 'Service items' })
    const billing = within(services).getByRole('row', { name: /Billing Service/ })
    expect(within(billing).getByText('Product One')).toBeTruthy()
    expect(within(billing).getByText('billing')).toBeTruthy()
    const vendors = screen.getByRole('table', { name: 'Vendor items' })
    expect(within(within(vendors).getByRole('row', { name: /Vendor One/ })).getByText('Not attached')).toBeTruthy()
  })

  it('shows an empty state for a kind without items and for no kinds', async () => {
    fake.items = []
    renderApp(<ItemsPage />)
    expect((await screen.findAllByText(/No items yet/)).length).toBe(2)
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows a load error', async () => {
    server.use(
      http.get(`${API}/v1/items`, () => HttpResponse.json({ error: { code: 'internal', message: 'down' } }, { status: 500 })),
    )
    renderApp(<ItemsPage />)
    expect((await screen.findByText(/Could not load items: down/)).getAttribute('role')).toBe('alert')
  })

  it('says so when there are no kinds yet', async () => {
    fake.kinds = []
    fake.items = []
    renderApp(<ItemsPage />)
    expect(await screen.findByText(/No item kinds yet/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add kind' })).toBeTruthy()
  })

  it('adds a kind with an ID taken from its name', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Add kind' }))
    const dialog = screen.getByRole('dialog', { name: 'Add item kind' })
    await user.type(within(dialog).getByLabelText('Name'), 'Data Source')
    expect((within(dialog).getByLabelText('ID') as HTMLInputElement).value).toBe('data-source')
    await user.click(within(dialog).getByRole('button', { name: 'Add kind' }))
    await waitFor(() => expect(writes('POST', '/item-kinds')).toHaveLength(1))
    expect(writes('POST', '/item-kinds')[0]?.body).toEqual({ id: 'data-source', name: 'Data Source' })
    expect(await screen.findByRole('heading', { level: 2, name: 'Data Source' })).toBeTruthy()
  })

  it('adds an item to a kind, attached to an org unit, with source keys parsed', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Add Service item' }))
    const dialog = screen.getByRole('dialog', { name: 'Add item' })
    expect((within(dialog).getByLabelText('Kind') as HTMLSelectElement).value).toBe('service')
    await user.type(within(dialog).getByLabelText('Name'), 'Search Service')
    expect((within(dialog).getByLabelText('ID') as HTMLInputElement).value).toBe('search-service')
    await user.selectOptions(within(dialog).getByLabelText('Org unit'), 'seg-b')
    await user.type(within(dialog).getByLabelText('Source keys'), 'search, Search API ,')
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }))
    await waitFor(() => expect(writes('POST', '/items')).toHaveLength(1))
    expect(writes('POST', '/items')[0]?.body).toEqual({
      id: 'search-service',
      kindId: 'service',
      name: 'Search Service',
      orgUnitId: 'seg-b',
      sourceKeys: ['search', 'Search API'],
    })
    const services = screen.getByRole('table', { name: 'Service items' })
    expect(await within(services).findByRole('row', { name: /Search Service/ })).toBeTruthy()
  })

  it('can create an item of another kind than the section it was opened from', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Add Service item' }))
    const dialog = screen.getByRole('dialog', { name: 'Add item' })
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'vendor')
    await user.type(within(dialog).getByLabelText('Name'), 'Vendor Two')
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }))
    await waitFor(() => expect(writes('POST', '/items')).toHaveLength(1))
    expect(writes('POST', '/items')[0]?.body).toMatchObject({ kindId: 'vendor', orgUnitId: '', sourceKeys: [] })
  })

  it('validates a new item and shows a duplicate ID at the ID field', async () => {
    fake.failNext.set('POST /items', { status: 409, code: 'conflict', message: 'item svc-1 already exists' })
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Add Service item' }))
    const dialog = screen.getByRole('dialog', { name: 'Add item' })
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }))
    const name = within(dialog).getByLabelText('Name')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(name)
    expect(writes('POST', '/items')).toHaveLength(0)

    await user.type(name, 'Billing Service')
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }))
    const id = within(dialog).getByLabelText('ID')
    await waitFor(() => expect(id.getAttribute('aria-invalid')).toBe('true'))
    expect(describedText(id)).toContain('item svc-1 already exists')
  })

  it('edits an item: sends only what changed and can detach it from its org unit', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Edit Billing Service' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit Billing Service' })
    expect(within(dialog).getByText('Service')).toBeTruthy()
    await user.selectOptions(within(dialog).getByLabelText('Org unit'), '')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(writes('PATCH', '/items/svc-1')).toHaveLength(1))
    expect(writes('PATCH', '/items/svc-1')[0]?.body).toEqual({ orgUnitId: '' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const billing = within(screen.getByRole('table', { name: 'Service items' })).getByRole('row', { name: /Billing Service/ })
    await waitFor(() => expect(within(billing).getByText('Not attached')).toBeTruthy())
  })

  it('renames an item and edits its source keys, and maps a key collision to the field', async () => {
    fake.failNext.set('PATCH /items/svc-1', {
      status: 400,
      code: 'invalid',
      message: 'request validation failed',
      details: [{ path: 'sourceKeys[1]', message: 'source key "seg a" is already used by org unit seg-a' }],
    })
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Edit Billing Service' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit Billing Service' })
    const name = within(dialog).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'Billing')
    const keys = within(dialog).getByLabelText('Source keys')
    await user.clear(keys)
    await user.type(keys, 'billing, seg a')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(keys.getAttribute('aria-invalid')).toBe('true'))
    expect(describedText(keys)).toContain('is already used by org unit seg-a')
    expect(document.activeElement).toBe(keys)
    expect(writes('PATCH', '/items/svc-1')[0]?.body).toEqual({ name: 'Billing', sourceKeys: ['billing', 'seg a'] })
  })

  it('has no axe violations on the page or in its dialogs', async () => {
    const { user, container } = await setup()
    expect((await axe(container)).violations).toEqual([])
    for (const [open, title] of [
      ['Add kind', 'Add item kind'],
      ['Add Service item', 'Add item'],
      ['Edit Billing Service', 'Edit Billing Service'],
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
})
