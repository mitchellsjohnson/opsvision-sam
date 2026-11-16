import { ShieldCheck } from 'lucide-react'
import { useCallback, useRef, useState, type FormEvent } from 'react'
import {
  useAssistantSettings,
  useDeleteAssistantCredential,
  useMyAssistantCredential,
  usePutAssistantCredential,
} from '../../api/queries'
import { NO_ERRORS, errorsFrom, fieldError, forField, unclaimed, type FormErrors } from '../admin/adminModel'
import { FormError, QueryState, TextField, primaryButton, secondaryButton, useFocusOnError } from '../admin/formUi'
import { PRIVACY_LINE } from '../assistant/AskSamDrawer'
import { formatDate } from '../scorecard/format'
import { Sam } from '../../ui/Sam'

const cardClass = 'rounded-lg border border-ink/15 bg-white p-5'

function KeyForm({ onSaved, onCancel }: { onSaved: () => void; onCancel?: () => void }) {
  const put = usePutAssistantCredential()
  const { formRef, focusErrors } = useFocusOnError()
  const [apiKey, setApiKey] = useState('')
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const trimmed = apiKey.trim()
    if (trimmed === '') {
      setErrors(fieldError('apiKey', 'Paste your Claude API key.'))
      focusErrors()
      return
    }
    try {
      await put.mutateAsync(trimmed)
      setApiKey('')
      put.reset()
      onSaved()
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="mt-4 space-y-3">
      <TextField
        label="Claude API key"
        hint="Create a key in your Claude account’s console, then paste it here. SAM checks it with one small request."
        type="password"
        autoComplete="off"
        spellCheck={false}
        maxLength={512}
        value={apiKey}
        errors={forField(errors, 'apiKey')}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <FormError messages={unclaimed(errors, ['apiKey'])} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButton} disabled={put.isPending}>
          {put.isPending ? 'Checking the key…' : 'Save key'}
        </button>
        {onCancel && (
          <button type="button" className={secondaryButton} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

/** My settings → Ask SAM: the person's own model provider key, and the model their organization uses. */
export function AskSamSettingsPage() {
  const credential = useMyAssistantCredential()
  const settings = useAssistantSettings()
  const remove = useDeleteAssistantCredential()
  const [replacing, setReplacing] = useState(false)
  const [notice, setNotice] = useState('')
  /** After a cancelled replacement, focus returns to Replace key once it is back. */
  const refocusReplace = useRef(false)
  const replaceRef = useCallback((el: HTMLButtonElement | null) => {
    if (el && refocusReplace.current) {
      refocusReplace.current = false
      el.focus()
    }
  }, [])
  const status = credential.data

  function removeKey() {
    setNotice('')
    remove.mutate(undefined, { onSuccess: () => setNotice('Key removed.') })
  }

  return (
    <section className="max-w-3xl space-y-4">
      <div className="flex items-start gap-4">
        <Sam pose="happy" className="size-14 shrink-0" />
        <div>
          <p className="text-sm font-medium text-ink/80">My settings</p>
          <h1 className="text-2xl font-semibold text-accent-deep">Ask SAM</h1>
          <p className="mt-1 max-w-prose text-sm text-ink/80">
            SAM answers questions about your scorecards: why a number moved, how a metric is measured, and what to look
            at next. It reads only the data you can see and never changes anything. SAM uses your own Claude API key,
            stored encrypted; the key is never shown again after you save it.
          </p>
          <p className="mt-2 flex max-w-prose items-start gap-2 text-sm text-ink/80">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-deep" />
            <span>{PRIVACY_LINE}</span>
          </p>
        </div>
      </div>

      <p role="status" className="min-h-5 text-sm font-medium text-status-g">
        {notice}
      </p>

      <section aria-labelledby="ask-sam-key" className={cardClass}>
        <h2 id="ask-sam-key" className="text-lg font-semibold text-accent-deep">
          Your key
        </h2>
        <QueryState isPending={credential.isPending} error={credential.error} what="your key status" />
        {status && !status.configured && <p className="mt-1 text-sm">No key saved.</p>}
        {status?.configured && (
          <p className="mt-1 text-sm">
            Saved key <code className="rounded bg-cream px-1.5 py-0.5 font-mono">{`•••• ${status.last4 ?? ''}`}</code>
            {status.updatedAt && <span className="text-ink/80">{`, saved ${formatDate(status.updatedAt)}`}</span>}
          </p>
        )}
        {status && (!status.configured || replacing) && (
          <KeyForm
            key={status.configured ? 'replace' : 'add'}
            onSaved={() => {
              setReplacing(false)
              setNotice('Key saved. SAM is ready.')
            }}
            onCancel={
              status.configured
                ? () => {
                    refocusReplace.current = true
                    setReplacing(false)
                  }
                : undefined
            }
          />
        )}
        {status?.configured && !replacing && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              ref={replaceRef}
              type="button"
              className={secondaryButton}
              onClick={() => {
                setNotice('')
                setReplacing(true)
              }}
            >
              Replace key
            </button>
            <button type="button" className={secondaryButton} disabled={remove.isPending} onClick={removeKey}>
              {remove.isPending ? 'Removing…' : 'Remove key'}
            </button>
          </div>
        )}
        {remove.isError && (
          <p role="alert" className="mt-2 text-sm font-medium text-status-r">
            Could not remove the key: {remove.error.message}
          </p>
        )}
      </section>

      <section aria-labelledby="ask-sam-model" className={cardClass}>
        <h2 id="ask-sam-model" className="text-lg font-semibold text-accent-deep">
          Model
        </h2>
        <QueryState isPending={settings.isPending} error={settings.error} what="the model in use" />
        {settings.data && (
          <>
            <p className="mt-1 text-sm">
              SAM answers with <code className="rounded bg-cream px-1.5 py-0.5 font-mono">{settings.data.model}</code>.
              Your key is charged for each answer. An admin chooses the model.
            </p>
            {!settings.data.enabled && (
              <p className="mt-2 rounded-md border border-amber bg-cream px-3 py-2 text-sm">
                An admin has turned Ask SAM off for this organization. Your key stays saved.
              </p>
            )}
          </>
        )}
      </section>
    </section>
  )
}
