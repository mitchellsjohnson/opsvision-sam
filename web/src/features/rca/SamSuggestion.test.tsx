import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SamSuggestion } from './SamSuggestion'

function renderSuggestion(warnings: string[]) {
  return render(<SamSuggestion text="Drafted." sources="from 4 incidents" warnings={warnings} onUse={() => {}} onDiscard={() => {}} />)
}

describe('SamSuggestion', () => {
  it('warns about a key SAM named that is not linked to this metric', () => {
    renderSuggestion(['INC-9999'])
    expect(screen.getByText('SAM mentioned INC-9999, which is not linked to this metric. Check it before using this draft.')).toBeTruthy()
  })

  it('gives a URL its own sentence, as text and never a link', () => {
    renderSuggestion(['https://status.example/incidents/77'])
    expect(
      screen.getByText('SAM’s draft has a link that is not in this metric’s attribution: https://status.example/incidents/77. Check it before using this draft.'),
    ).toBeTruthy()
    expect(screen.queryByText(/SAM mentioned https:/)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
