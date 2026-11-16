import { http, HttpResponse } from 'msw'
import type { components } from '../api/schema'
import { API } from './server'

type Thread = components['schemas']['AssistantThread']
type Message = components['schemas']['AssistantMessage']
type Settings = components['schemas']['AssistantSettings']
type Usage = components['schemas']['AssistantUsage']
type Draft = components['schemas']['ReportSummaryDraft']

export const USAGE: Usage = { model: 'claude-haiku-5-5', inputTokens: 1234, outputTokens: 56, toolCalls: 2 }

/** How the fake SAM answers a question: Markdown text, or an error sentence. */
export type Reply = { text: string } | { error: string }

export interface AssistantSeen {
  posts: { threadId: string; body: unknown }[]
  threadCreates: unknown[]
  threadGets: number
  credentialPuts: unknown[]
  credentialDeletes: number
  settingsPuts: unknown[]
  draftPosts: unknown[]
  draftGets: number
}

export function newAssistantSeen(): AssistantSeen {
  return {
    posts: [],
    threadCreates: [],
    threadGets: 0,
    credentialPuts: [],
    credentialDeletes: 0,
    settingsPuts: [],
    draftPosts: [],
    draftGets: 0,
  }
}

export interface AssistantFakeOptions {
  /** A key is saved (with these last 4 characters) when set. */
  last4?: string
  settings?: Settings
  /** Answers, in order, one per question; the last one repeats. */
  replies?: Reply[]
  /** Thread reads that still show the answer pending before it is written. */
  pendingReads?: number
  /** Chats that already exist, most recently used first. */
  threads?: Thread[]
  /** The report summary draft's outcome. */
  draft?: Reply
  seen?: AssistantSeen
}

export function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 'th-1',
    title: 'New chat',
    createdAt: '2026-11-15T10:00:00Z',
    updatedAt: '2026-11-15T10:00:00Z',
    messages: [],
    ...over,
  }
}

export function message(over: Partial<Message> = {}): Message {
  return { id: 'm-1', role: 'user', text: '', status: 'done', createdAt: '2026-11-15T10:00:00Z', ...over }
}

/** An in-memory Ask SAM API: credential, settings, chats that answer after a few reads, and drafts. */
export function assistantHandlers(options: AssistantFakeOptions = {}) {
  const seen = options.seen ?? newAssistantSeen()
  let credential: components['schemas']['AssistantCredentialStatus'] = options.last4
    ? { configured: true, last4: options.last4, updatedAt: '2026-11-01T09:00:00Z' }
    : { configured: false }
  let settings: Settings = options.settings ?? { enabled: true, model: 'claude-haiku-5-5' }
  const threads = new Map<string, Thread>((options.threads ?? []).map((t) => [t.id, structuredClone(t)]))
  const replies = options.replies ?? [{ text: 'On-time delivery is **84.3%** in Oct 2026.' }]
  let asked = 0
  let reads = 0
  let nextId = 1

  const resolve = (t: Thread) => {
    const pending = t.messages.find((m) => m.status === 'pending')
    if (!pending) return
    reads += 1
    if (reads <= (options.pendingReads ?? 0)) return
    const reply = replies[Math.min(asked - 1, replies.length - 1)]!
    if ('text' in reply) Object.assign(pending, { status: 'done', text: reply.text, usage: USAGE })
    else Object.assign(pending, { status: 'error', error: reply.error, usage: USAGE })
  }

  return [
    http.get(`${API}/v1/me/assistant/credential`, () => HttpResponse.json(credential)),
    http.put(`${API}/v1/me/assistant/credential`, async ({ request }) => {
      const body = (await request.json()) as { apiKey: string }
      seen.credentialPuts.push(body)
      if (body.apiKey.includes('bad')) {
        return HttpResponse.json(
          { error: { code: 'invalid', message: 'That key was rejected by the provider.' } },
          { status: 400 },
        )
      }
      credential = { configured: true, last4: body.apiKey.trim().slice(-4), updatedAt: '2026-11-15T12:00:00Z' }
      return HttpResponse.json(credential)
    }),
    http.delete(`${API}/v1/me/assistant/credential`, () => {
      seen.credentialDeletes += 1
      credential = { configured: false }
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`${API}/v1/assistant/settings`, () => HttpResponse.json(settings)),
    http.put(`${API}/v1/assistant/settings`, async ({ request }) => {
      const body = (await request.json()) as Settings
      seen.settingsPuts.push(body)
      if (!/^[a-z0-9.-]{1,100}$/.test(body.model)) {
        return HttpResponse.json(
          {
            error: {
              code: 'invalid',
              message: 'request validation failed',
              details: [{ path: 'model', message: 'must be a model id' }],
            },
          },
          { status: 400 },
        )
      }
      settings = body
      return HttpResponse.json(settings)
    }),
    http.get(`${API}/v1/assistant/threads`, () =>
      HttpResponse.json({
        threads: [...threads.values()].map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt })),
      }),
    ),
    http.post(`${API}/v1/assistant/threads`, async ({ request }) => {
      const body = (await request.json()) as { context?: components['schemas']['AssistantContext'] }
      seen.threadCreates.push(body)
      const t = thread({ id: `th-new-${nextId++}`, context: body.context })
      threads.set(t.id, t)
      return HttpResponse.json(t, { status: 201 })
    }),
    http.get(`${API}/v1/assistant/threads/:id`, ({ params }) => {
      seen.threadGets += 1
      const t = threads.get(String(params.id))
      if (!t) return HttpResponse.json({ error: { code: 'not_found', message: 'no such thread' } }, { status: 404 })
      resolve(t)
      return HttpResponse.json(t)
    }),
    http.post(`${API}/v1/assistant/threads/:id/messages`, async ({ params, request }) => {
      const body = (await request.json()) as { text: string }
      const t = threads.get(String(params.id))!
      seen.posts.push({ threadId: t.id, body })
      if (t.messages.some((m) => m.status === 'pending')) {
        return HttpResponse.json(
          { error: { code: 'conflict', message: 'SAM is still answering. Wait for the reply before asking again.' } },
          { status: 409 },
        )
      }
      asked += 1
      reads = 0
      const n = nextId++
      if (t.messages.length === 0) t.title = body.text.slice(0, 60)
      t.messages.push(
        message({ id: `m-q${n}`, role: 'user', text: body.text, createdAt: `2026-11-15T10:0${n % 10}:00Z` }),
        message({ id: `m-a${n}`, role: 'assistant', status: 'pending', createdAt: `2026-11-15T10:0${n % 10}:01Z` }),
      )
      return HttpResponse.json(t, { status: 202 })
    }),
    http.post(`${API}/v1/scorecards/:sc/reports/:period/summary/draft`, async ({ request }) => {
      seen.draftPosts.push(await request.json().catch(() => null))
      const d: Draft = { id: 'dr-1', pending: true, createdAt: '2026-11-15T10:00:00Z' }
      return HttpResponse.json(d, { status: 202 })
    }),
    http.get(`${API}/v1/scorecards/:sc/reports/:period/summary/draft/:id`, () => {
      seen.draftGets += 1
      const outcome = options.draft ?? { text: 'October was steady: on-time delivery held at 84.3%.' }
      const d: Draft = { id: 'dr-1', pending: false, createdAt: '2026-11-15T10:00:00Z', usage: USAGE, ...outcome }
      return HttpResponse.json(d)
    }),
  ]
}
