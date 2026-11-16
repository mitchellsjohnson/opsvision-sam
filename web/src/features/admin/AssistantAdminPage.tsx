import { useId, useState, type FormEvent } from 'react'
import { useAssistantSettings, usePutAssistantSettings, type AssistantSettings } from '../../api/queries'
import { NO_ERRORS, errorsFrom, fieldError, forField, unclaimed, type FormErrors } from './adminModel'
import { FieldMessages, FormError, QueryState, inputClass, primaryButton, useFocusOnError } from './formUi'

const OFFERED = [
  { id: 'claude-haiku-5-5', note: 'Default. Fast and lower cost; good for most questions.' },
  { id: 'claude-sonnet-5-5', note: 'Stronger reasoning over larger views; costs more per answer.' },
] as const

const OTHER = 'other'
const MODEL_ID = /^[a-z0-9.-]{1,100}$/

function SettingsForm({ saved }: { saved: AssistantSettings }) {
  const put = usePutAssistantSettings()
  const { formRef, focusErrors } = useFocusOnError()
  const offered = OFFERED.some((m) => m.id === saved.model)
  const [enabled, setEnabled] = useState(saved.enabled)
  const [choice, setChoice] = useState<string>(offered ? saved.model : OTHER)
  const [custom, setCustom] = useState(offered ? '' : saved.model)
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)
  const [notice, setNotice] = useState('')
  const id = useId()
  const customErrors = forField(errors, 'model')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setNotice('')
    const model = choice === OTHER ? custom.trim() : choice
    if (!MODEL_ID.test(model)) {
      setErrors(fieldError('model', 'Enter a model id. Use lowercase letters, digits, dots and dashes, such as claude-haiku-5-5.'))
      focusErrors()
      return
    }
    setErrors(NO_ERRORS)
    try {
      const out = await put.mutateAsync({ enabled, model })
      setNotice(out.enabled ? `Saved. SAM answers with ${out.model}.` : 'Saved. Ask SAM is off.')
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-5">
      <section className="rounded-lg border border-ink/15 bg-white p-5">
        <div className="flex items-start gap-3">
          <input
            id={`${id}-enabled`}
            type="checkbox"
            className="mt-0.5 size-4 accent-accent"
            checked={enabled}
            aria-describedby={`${id}-enabled-hint`}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <div>
            <label htmlFor={`${id}-enabled`} className="block text-sm font-medium">
              Let members use Ask SAM
            </label>
            <p id={`${id}-enabled-hint`} className="text-sm text-ink/80">
              Each person adds their own Claude API key in My settings, and pays for their own answers.
            </p>
          </div>
        </div>
      </section>

      <div className="rounded-lg border border-ink/15 bg-white p-5">
      <fieldset role="radiogroup" aria-labelledby={`${id}-legend`} aria-describedby={`${id}-hint`}>
        <legend id={`${id}-legend`} className="text-sm font-semibold">
          Model
        </legend>
        <p id={`${id}-hint`} className="text-sm text-ink/80">
          The model SAM answers with, for everyone in the organization.
        </p>
        <div className="mt-3 space-y-2">
          {OFFERED.map((m) => (
            <div key={m.id} className="flex items-start gap-3 rounded-md border border-ink/15 px-3 py-2 has-[:checked]:border-accent">
              <input
                id={`${id}-${m.id}`}
                type="radio"
                name={`${id}-model`}
                className="mt-1 size-4 accent-accent"
                checked={choice === m.id}
                aria-describedby={`${id}-${m.id}-note`}
                onChange={() => setChoice(m.id)}
              />
              <div className="text-sm">
                <label htmlFor={`${id}-${m.id}`} className="block cursor-pointer font-mono font-medium">
                  {m.id}
                </label>
                <p id={`${id}-${m.id}-note`} className="text-ink/80">
                  {m.note}
                </p>
              </div>
            </div>
          ))}
          <div className="rounded-md border border-ink/15 px-3 py-2 has-[:checked]:border-accent">
            <label className="flex items-center gap-3">
              <input
                type="radio"
                name={`${id}-model`}
                className="size-4 accent-accent"
                checked={choice === OTHER}
                onChange={() => setChoice(OTHER)}
              />
              <span className="text-sm font-medium">Another model</span>
            </label>
            {choice === OTHER && (
              <div className="mt-2 pl-7">
                <label htmlFor={`${id}-custom`} className="block text-sm font-medium">
                  Model id
                </label>
                <input
                  id={`${id}-custom`}
                  value={custom}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={100}
                  onChange={(e) => setCustom(e.target.value)}
                  aria-invalid={customErrors.length > 0 ? true : undefined}
                  aria-describedby={customErrors.length > 0 ? `${id}-custom-err` : undefined}
                  className={`${inputClass} font-mono`}
                />
                <FieldMessages id={`${id}-custom-err`} errors={customErrors} />
              </div>
            )}
          </div>
        </div>
        {choice !== OTHER && <FieldMessages id={`${id}-model-err`} errors={customErrors} />}
      </fieldset>
      </div>

      <FormError messages={unclaimed(errors, ['model'])} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={primaryButton} disabled={put.isPending}>
          {put.isPending ? 'Saving…' : 'Save'}
        </button>
        <p role="status" className="text-sm font-medium text-status-g">
          {notice}
        </p>
      </div>
    </form>
  )
}

/** Admin → Ask SAM: whether members can use SAM, and which model it answers with. */
export function AssistantAdminPage() {
  const settings = useAssistantSettings()
  return (
    <section className="max-w-3xl space-y-4">
      <div>
        <p className="text-sm font-medium text-ink/80">Admin</p>
        <h1 className="text-2xl font-semibold text-accent-deep">Ask SAM</h1>
        <p className="mt-1 max-w-prose text-sm text-ink/80">
          SAM is the in-app guide. It reads scorecard data and help topics as the person asking, and never changes
          anything.
        </p>
      </div>
      <QueryState isPending={settings.isPending} error={settings.error} what="Ask SAM settings" />
      {settings.data && <SettingsForm saved={settings.data} />}
    </section>
  )
}
