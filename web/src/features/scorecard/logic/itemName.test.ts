import { expect, test } from 'vitest'
import { splitItemName } from './itemName'

test.each([
  ['Analytics Warehouse - Batch Loader Primary', 'Analytics Warehouse', ' - Batch Loader Primary'],
  ['Payments Gateway – EU Region Primary', 'Payments Gateway', ' – EU Region Primary'],
  ['Search Indexer - Production Cluster A-1', 'Search Indexer', ' - Production Cluster A-1'],
  ['Ops · Billing · Nightly', 'Ops · Billing', ' · Nightly'],
  ['Payments Gateway (EU Primary)', 'Payments Gateway', ' (EU Primary)'],
  ['Edge Cache', '', 'Edge Cache'],
  ['- Primary', '', '- Primary'],
  ['Search /', '', 'Search /'],
  ['Billing — Nightly Batch', 'Billing', ' — Nightly Batch'],
  ['Region: EU West', 'Region', ': EU West'],
  ['Ledger', '', 'Ledger'],
  ['', '', ''],
])('splitItemName(%s)', (name, head, tail) => expect(splitItemName(name)).toEqual({ head, tail }))

test('a separator at the end does not hide an earlier one', () => {
  expect(splitItemName('Search Indexer - Cluster B -')).toEqual({ head: 'Search Indexer', tail: ' - Cluster B -' })
})

test('head and tail always make the name', () => {
  for (const name of ['Customer Portal - Private Cloud Tenant Suite', 'Payments Gateway (EU Primary)', 'A / B / C', 'x']) {
    const { head, tail } = splitItemName(name)
    expect(head + tail).toBe(name)
  }
})
