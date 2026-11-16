import type { AssistantUsage } from '../../api/queries'

const count = new Intl.NumberFormat('en-US')

/** `claude-haiku-5-5 · 1,234 in · 56 out tokens` */
export function usageText(usage: AssistantUsage): string {
  return `${usage.model} · ${count.format(usage.inputTokens)} in · ${count.format(usage.outputTokens)} out tokens`
}

/** What an answer cost: the model and its tokens. */
export function UsageLine({ usage }: { usage: AssistantUsage }) {
  return <p className="mt-1 px-1 text-xs text-ink/70">{usageText(usage)}</p>
}
