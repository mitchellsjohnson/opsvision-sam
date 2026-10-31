import * as Dialog from '@radix-ui/react-dialog'
import clsx from 'clsx'
import { AlertCircle, X } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
} from 'react'

export const inputClass =
  'mt-1 block w-full rounded-md border border-ink/40 bg-white px-2 py-1.5 text-sm aria-[invalid=true]:border-status-r aria-[invalid=true]:border-2'
export const primaryButton =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-60'
export const secondaryButton =
  'rounded-md border border-ink/40 bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-cream disabled:opacity-60'
export const linkButton = 'rounded-md px-2 py-1 text-sm font-medium text-accent-deep underline hover:bg-white'

/** Messages for one field, linked to it with aria-describedby. */
export function FieldMessages({ id, errors }: { id: string; errors: readonly string[] }) {
  if (errors.length === 0) return null
  return (
    <p id={id} className="mt-1 flex items-start gap-1 text-sm font-medium text-status-r">
      <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        <span className="sr-only">Error: </span>
        {errors.join(' ')}
      </span>
    </p>
  )
}

interface FieldChrome {
  label: string
  hint?: string
  errors?: readonly string[]
}

function describedBy(hintId: string | undefined, errId: string | undefined) {
  const ids = [hintId, errId].filter(Boolean).join(' ')
  return ids === '' ? undefined : ids
}

export function TextField({
  label,
  hint,
  errors = [],
  className,
  ...input
}: FieldChrome & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errId = errors.length > 0 ? `${id}-err` : undefined
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-sm text-ink/80">
          {hint}
        </p>
      )}
      <input
        {...input}
        id={id}
        className={inputClass}
        aria-invalid={errors.length > 0 ? true : undefined}
        aria-describedby={describedBy(hintId, errId)}
      />
      <FieldMessages id={`${id}-err`} errors={errors} />
    </div>
  )
}

export interface Option {
  value: string
  label: string
}

export function SelectField({
  label,
  hint,
  errors = [],
  options,
  className,
  ...select
}: FieldChrome & { options: readonly Option[] } & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'children'>) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errId = errors.length > 0 ? `${id}-err` : undefined
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-sm text-ink/80">
          {hint}
        </p>
      )}
      <select
        {...select}
        id={id}
        className={inputClass}
        aria-invalid={errors.length > 0 ? true : undefined}
        aria-describedby={describedBy(hintId, errId)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldMessages id={`${id}-err`} errors={errors} />
    </div>
  )
}

/** Messages that belong to the whole form. Focusable so a failed submit can move focus here. */
export function FormError({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null
  return (
    <div
      role="alert"
      tabIndex={-1}
      data-form-error=""
      className="rounded-md border border-status-r bg-status-r-bg p-3 text-sm font-medium text-status-r"
    >
      <span className="sr-only">Error: </span>
      {messages.length === 1 ? (
        messages[0]
      ) : (
        <ul className="list-disc pl-5">
          {messages.map((m, i) => (
            <li key={`${i}-${m}`}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Moves focus to the first invalid field (or the form-level error) after a
 * failed submit. Call `focusErrors()` in the same handler that sets the
 * errors; the focus happens once they are rendered.
 */
export function useFocusOnError<T extends HTMLElement = HTMLFormElement>() {
  const formRef = useRef<T>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (tick === 0) return
    const root = formRef.current
    const first =
      root?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]') ??
      root?.querySelector<HTMLElement>('[data-form-error]')
    first?.focus()
  }, [tick])
  return { formRef, focusErrors: () => setTick((t) => t + 1) }
}

export interface FormDialogProps {
  triggerLabel: ReactNode
  triggerAriaLabel?: string
  triggerClassName?: string
  title: string
  description: string
  /** Where focus goes when the dialog closes and the trigger is gone (e.g. the row was removed). */
  fallbackFocus?: RefObject<HTMLElement | null>
  wide?: boolean
  children: (close: () => void) => ReactNode
}

/** A modal dialog with a trigger button. Focus moves in on open and returns to the trigger on close. */
export function FormDialog({
  triggerLabel,
  triggerAriaLabel,
  triggerClassName = secondaryButton,
  title,
  description,
  fallbackFocus,
  wide,
  children,
}: FormDialogProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button ref={triggerRef} type="button" aria-label={triggerAriaLabel} className={triggerClassName}>
          {triggerLabel}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          onCloseAutoFocus={(e) => {
            if (!triggerRef.current?.isConnected && fallbackFocus?.current) {
              e.preventDefault()
              fallbackFocus.current.focus()
            }
          }}
          className={clsx(
            'fixed left-1/2 top-1/2 z-50 max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-6 shadow-xl',
            wide ? 'w-[min(94vw,44rem)]' : 'w-[min(94vw,32rem)]',
          )}
        >
          <Dialog.Title className="pr-8 text-lg font-semibold text-accent-deep">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-ink/80">{description}</Dialog.Description>
          <div className="mt-4">{open && children(() => setOpen(false))}</div>
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="absolute right-3 top-3 rounded-md p-1 hover:bg-cream"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Cancel and submit buttons at the end of a dialog form. */
export function FormActions({
  submitLabel,
  pending,
  onCancel,
}: {
  submitLabel: string
  pending: boolean
  onCancel: () => void
}) {
  return (
    <div className="mt-2 flex justify-end gap-2">
      <button type="button" className={secondaryButton} onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className={primaryButton} disabled={pending}>
        {pending ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}

/** Loading, error and empty states shared by the admin pages. */
export function QueryState({
  isPending,
  error,
  what,
}: {
  isPending: boolean
  error: Error | null
  what: string
}) {
  if (isPending) return <p role="status">Loading {what}…</p>
  if (error) return <p role="alert" className="font-medium text-status-r">Could not load {what}: {error.message}</p>
  return null
}
