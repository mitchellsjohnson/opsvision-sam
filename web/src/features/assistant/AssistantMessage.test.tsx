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
      <AssistantMarkdown
        text={'See [the guide](https://example.test/guide) or [this](javascript:alert(1)).'}
        allowedHosts={['example.test']}
      />,
    )
    const link = screen.getByRole('link', { name: /the guide/ })
    expect(link.getAttribute('href')).toBe('https://example.test/guide')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.textContent).toContain('(opens in a new tab)')
    expect(container.innerHTML).not.toContain('javascript:')
  })

  it.each([
    ['a script URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
  ])('shows a link with %s as plain text', (_, url) => {
    const { container } = render(<AssistantMarkdown text={`Open [this page](${url}) now.`} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('Open this page now.')
  })

  describe('links only to the hosts of the turn (spec §9.4)', () => {
    const allowed = ['tracker.example', 'Docs.Example']

    it('keeps links to allowed hosts, in any case, and paths in the app', () => {
      render(
        <AssistantMarkdown
          text={`[INC-2041](https://tracker.example/browse/INC-2041), [pm](https://DOCS.example/pm), [the board](/scorecards/delivery/view), [here](${window.location.origin}/x) and [odd [title]](https://tracker.example/y).`}
          allowedHosts={allowed}
        />,
      )
      const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
      expect(hrefs).toEqual([
        'https://tracker.example/browse/INC-2041',
        'https://DOCS.example/pm',
        '/scorecards/delivery/view',
        `${window.location.origin}/x`,
        'https://tracker.example/y',
      ])
    })

    it('shows a link to another host as its title and the host, not a link', () => {
      const { container } = render(
        <AssistantMarkdown text={'Read [the fix](https://evil.example/steal?x=1) now.'} allowedHosts={allowed} />,
      )
      expect(container.querySelector('a')).toBeNull()
      expect(container.textContent).toBe('Read the fix (evil.example) now.')
    })

    it('treats an answer stored without hosts as having none', () => {
      const { container } = render(<AssistantMarkdown text={'See [docs](https://docs.example/a) and [the board](/x).'} />)
      expect(container.textContent).toBe('See docs (docs.example) and the board (opens in a new tab).')
      expect(screen.getByRole('link', { name: /the board/ }).getAttribute('href')).toBe('/x')
    })

    // Every CommonMark form the server's regex missed, as the review found them.
    it.each([
      ['brackets in the title', '[a [b] c](https://evil.example/x)', 'a [b] c (evil.example)'],
      ['an escaped bracket', '[a\\]b](https://evil.example/x)', 'a]b (evil.example)'],
      ['a title on two lines', '[a\nb](https://evil.example/x)', 'a\nb (evil.example)'],
      ['an escaped parenthesis', '[x](https://evil.example/\\(a)', 'x (evil.example)'],
      ['nested parentheses', '[x](https://evil.example/a((b)))', 'x (evil.example)'],
      ['a reference with the URL on the next line', 'See [x][1].\n\n[1]:\n  https://evil.example/a', 'See x (evil.example).'],
      ['escaped backticks', '\\`[x](https://evil.example/x)\\`', '`x (evil.example)`'],
      ['an entity colon', '[x](https&#58;//evil.example/x)', 'x (evil.example)'],
      ['entity slashes', '[x](&#x2F;&#x2F;evil.example/x)', 'x (evil.example)'],
      ['no slashes', '[x](https:evil.example)', 'x (evil.example)'],
      // The renderer percent-encodes the backslashes, so this one names no host at all.
      ['backslashes for slashes', '[x](https:\\\\\\\\evil.example)', 'x'],
      ['a protocol-relative URL', '[x](//evil.example/a)', 'x (evil.example)'],
      ['user info', '[x](https://tracker.example@evil.example/a)', 'x (evil.example)'],
      ['a subdomain', '[x](https://a.tracker.example/y)', 'x (a.tracker.example)'],
      ['an autolink', '<https://evil.example/a>', 'https://evil.example/a (evil.example)'],
      ['a mail link', '[x](mailto:x@evil.example)', 'x'],
    ])('shows %s as text', (_, text, shown) => {
      const { container } = render(<AssistantMarkdown text={text} allowedHosts={allowed} />)
      expect(container.querySelector('a')).toBeNull()
      expect(container.textContent).toBe(shown)
    })
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

  it('links an answer only to the hosts stored with it', () => {
    renderItem({
      message: message({
        role: 'assistant',
        text: '[INC-2041](https://tracker.example/a) and [the fix](https://evil.example/b)',
        allowedHosts: ['tracker.example'],
      }),
    })
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['https://tracker.example/a'])
    expect(screen.getByText(/the fix \(evil\.example\)/)).toBeTruthy()
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
