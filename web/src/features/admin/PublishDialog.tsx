import { useState, type FormEvent } from 'react'
import { ApiError } from '../../api/errors'
import { usePublishVersion, type MethodologyVersion } from '../../api/queries'
import { addMonths, labelOfMonth, monthOptions } from './adminModel'
import { FormActions, FormDialog, FormError, SelectField, primaryButton, useFocusOnError } from './formUi'

function PublishForm({
  sc,
  version,
  fiscal,
  now,
  defaultMonth,
  close,
  onPublished,
}: {
  sc: string
  version: MethodologyVersion
  fiscal: number
  now: string
  defaultMonth?: string
  close: () => void
  onPublished: (message: string, ok: boolean) => void
}) {
  const publish = usePublishVersion(sc)
  const { formRef, focusErrors } = useFocusOnError()
  const [month, setMonth] = useState(defaultMonth ?? addMonths(now, 1))
  const [messages, setMessages] = useState<string[]>([])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMessages([])
    try {
      const res = await publish.mutateAsync({ v: version.id, effectiveFrom: month })
      const done = `Published ${version.name}, effective ${labelOfMonth(month, fiscal)}`
      // The publish stands even when recalculating failed; say so rather than claim success.
      if (res.recalculationError) {
        onPublished(
          `${done}, but the numbers that come from records couldn’t be updated yet. They update with your next records upload or publish.`,
          false,
        )
      } else {
        onPublished(`${done}.`, true)
      }
      close()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setMessages([`This version can no longer be published: ${err.message}`])
      } else if (err instanceof ApiError && err.details.length > 0) {
        setMessages(err.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)))
      } else {
        setMessages([err instanceof Error ? err.message : 'Something went wrong.'])
      }
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <SelectField
        label="Effective month"
        hint="The first month scorecards use this version."
        value={month}
        options={monthOptions(now, fiscal, defaultMonth)}
        onChange={(e) => setMonth(e.target.value)}
      />
      <FormError messages={messages} />
      <FormActions submitLabel="Publish" pending={publish.isPending} onCancel={close} />
    </form>
  )
}

/** Publishes a saved draft from a month. Disabled while there are unsaved changes. */
export function PublishDialog({
  sc,
  version,
  fiscal,
  now,
  disabled,
  onPublished,
  triggerLabel = 'Publish…',
  defaultMonth,
}: {
  sc: string
  version: MethodologyVersion
  fiscal: number
  now: string
  disabled: boolean
  /** `ok` is false when the version published but the numbers from records were not recalculated. */
  onPublished: (message: string, ok: boolean) => void
  triggerLabel?: string
  /** The effective month the form starts at (default: next month). */
  defaultMonth?: string
}) {
  return (
    <FormDialog
      triggerLabel={triggerLabel}
      triggerClassName={primaryButton}
      triggerDisabled={disabled}
      title={`Publish ${version.name}`}
      description="Choose the first month scorecards use this version. Earlier months keep using the version in force then."
      wide
    >
      {(close) => (
        <PublishForm
          sc={sc}
          version={version}
          fiscal={fiscal}
          now={now}
          defaultMonth={defaultMonth}
          close={close}
          onPublished={onPublished}
        />
      )}
    </FormDialog>
  )
}
