import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConfigErrorScreen } from './ConfigErrorScreen'

describe('ConfigErrorScreen', () => {
  it('shows the problem as an alert', () => {
    render(<ConfigErrorScreen message="Missing required configuration: VITE_AUTH0_DOMAIN." />)
    expect(screen.getByRole('alert').textContent).toContain('VITE_AUTH0_DOMAIN')
    expect(screen.getByRole('heading', { name: 'OpsVision cannot start' })).toBeTruthy()
  })
})
