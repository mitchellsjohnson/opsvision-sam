import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { message, USAGE } from '../../test/assistantFixtures'
import { AssistantMarkdown, AssistantMessageItem, spokenText } from './AssistantMessage'

function renderItem(...args: Parameters<typeof AssistantMessageItem>) {
  return render(
    <ul>
      <AssistantMessageItem {...args[0]} />
    </ul>,
  )
}

describe('AssistantMarkdown', () => {
  it('renders paragraphs, lists, bold, inline code and code blocks', () => {
    const { container } = render(
      <AssistantMarkdown
        text={'First **bold** line with `code`.\n\n- one\n- two\n\n1. first\n\n```\nblock\n```'}
      />,
    )
    expect(container.querySelectorAll('p').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('code').tagName).toBe('CODE')
    expect(container.querySelectorAll('ul li')).toHaveLength(2)
    expect(container.querySelectorAll('ol li')).toHaveLength(1)
    expect(container.querySelector('pre code')?.textContent).toBe('block\n')
  })

  it('never renders raw HTML or images', () => {
    const { container } = render(
      <AssistantMarkdown text={'Hi <b>there</b> <script>alert(1)</script><img src="x" onerror="alert(1)">\n\n![chart](https://example.test/leak?d=1)'} />,
    )
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).not.toContain('onerror')
  })

  it('opens links in a new tab without access to this one, and drops script URLs', () => {
    const { container } = render(
      <AssistantMarkdown text={'See [the guide](https://example.test/guide) or [this](javascript:alert(1)).'} />,
    )
    const link = screen.getByRole('link', { name: /the guide/ })
    expect(link.getAttribute('href')).toBe('https://example.test/guide')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.textContent).toContain('(opens in a new tab)')
    expect(container.innerHTML).not.toContain('javascript:')
  })

  it('renders headings as bold text, keeping the page outline', () => {
    render(<AssistantMarkdown text={'# Big\n\n## Smaller'} />)
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByText('Big').tagName).toBe('P')
  })
})

describe('AssistantMessageItem', () => {
  it('shows a question as the person’s bubble', () => {
    renderItem({ message: message({ text: 'Why is it red?\nAnd since when?' }) })
    const item = screen.getByRole('listitem')
    expect(item.textContent).toBe('You: Why is it red?\nAnd since when?')
  })

  it('shows an answer with its model and tokens', async () => {
    const { container } = renderItem({
      message: message({ role: 'assistant', text: 'Values are **live**.', usage: USAGE }),
    })
    expect(screen.getByText('live').tagName).toBe('STRONG')
    expect(screen.getByText('claude-haiku-5-5 · 1,234 in · 56 out tokens')).toBeTruthy()
    expect(container.querySelector('img[data-sam="mark"]')).toBeTruthy()
    expect((await axe(container)).violations).toEqual([])
  })

  it('shows a pending answer as SAM thinking', () => {
    const { container } = renderItem({ message: message({ role: 'assistant', status: 'pending' }) })
    expect(screen.getByText('SAM is looking into it')).toBeTruthy()
    expect(container.querySelector('img[data-sam="thinking"]')).toBeTruthy()
    expect(screen.getByRole('listitem').getAttribute('aria-busy')).toBe('true')
  })

  it('shows an error with its sentence and a retry', async () => {
    const onRetry = vi.fn()
    renderItem({
      message: message({ role: 'assistant', status: 'error', error: 'Claude could not be reached. Try again in a minute.' }),
      onRetry,
    })
    expect(screen.getByText('Claude could not be reached. Try again in a minute.')).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('offers no retry when the error is not the latest message', () => {
    renderItem({ message: message({ role: 'assistant', status: 'error', error: 'SAM took too long. Try again.' }) })
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})

describe('spokenText', () => {
  it('reads an answer as plain text', () => {
    expect(spokenText(message({ role: 'assistant', text: 'It is **84.3%** — see [help](https://example.test).' }))).toBe(
      'SAM replied: It is 84.3% — see help.',
    )
  })

  it('reads an error', () => {
    expect(spokenText(message({ role: 'assistant', status: 'error', error: 'SAM took too long. Try again.' }))).toBe(
      'SAM couldn’t answer. SAM took too long. Try again.',
    )
  })
})
