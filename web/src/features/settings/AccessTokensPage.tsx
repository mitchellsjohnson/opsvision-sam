import * as Dialog from '@radix-ui/react-dialog'
import { Copy, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react'
import { ApiError } from '../../api/errors'
import {
  useCreateToken,
  useDeleteToken,
  useMyTokens,
  type AccessToken,
  type CreatedAccessToken,
} from '../../api/queries'
import { getConfig } from '../../config'
import { NO_ERRORS, errorsFrom, fieldError, forField, unclaimed, type FormErrors } from '../admin/adminModel'
import {
  FormActions,
  FormError,
  QueryState,
  SelectField,
  TextField,
  inputClass,
  primaryButton,
  secondaryButton,
  useFocusOnError,
} from '../admin/formUi'
import { formatDate, formatDateTime } from '../scorecard/format'

const dangerButton =
  'rounded-md bg-status-r px-3 py-1.5 text-sm font-medium text-white hover:bg-status-r/90 disabled:opacity-60'

const EXPIRY_OPTIONS = [7, 30, 60, 90, 180, 365].map((d) => ({ value: String(d), label: `${d} days` }))

const LIMIT_MESSAGE = 'You have 10 active tokens. Revoke one to create another.'

const dialogClass =
  'fixed left-1/2 top-1/2 z-50 max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-6 shadow-xl'

/** The server entry an MCP client needs, with the token as its bearer credential. */
function mcpConfig(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        opsvision: {
          url: `${getConfig().apiUrl}/v1/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )
}

function CreateTokenForm({ onCreated, close }: { onCreated: (t: CreatedAccessToken) => void; close: () => void }) {
  const create = useCreateToken()
  const { formRef, focusErrors } = useFocusOnError()
  const [name, setName] = useState('')
  const [days, setDays] = useState('90')
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '') {
      setErrors(fieldError('name', 'Enter a name, such as the computer or script that will use the token.'))
      focusErrors()
      return
    }
    try {
      onCreated(await create.mutateAsync({ name: trimmed, expiresInDays: Number(days) }))
    } catch (err) {
      setErrors(err instanceof ApiError && err.status === 409 ? { fields: {}, general: [LIMIT_MESSAGE] } : errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <TextField
        label="Name"
        hint="Say where it is used, such as a laptop or a nightly script."
        autoComplete="off"
        maxLength={100}
        value={name}
        errors={forField(errors, 'name')}
        onChange={(e) => setName(e.target.value)}
      />
      <SelectField
        label="Expires in"
        value={days}
        options={EXPIRY_OPTIONS}
        errors={forField(errors, 'expiresInDays')}
        onChange={(e) => setDays(e.target.value)}
      />
      <FormError messages={unclaimed(errors, ['name', 'expiresInDays'])} />
      <FormActions submitLabel="Create token" pendingLabel="Creating…" pending={create.isPending} onCancel={close} />
    </form>
  )
}

function TokenReveal({ created, onDone }: { created: CreatedAccessToken; onDone: () => void }) {
  const tokenId = useId()
  const configId = useId()
  const copyRef = useRef<HTMLButtonElement>(null)
  const [copied, setCopied] = useState('')
  const config = mcpConfig(created.token)

  // The form's submit button is gone, so focus moves to the next thing to do.
  useEffect(() => copyRef.current?.focus(), [])

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(`${what[0]?.toUpperCase()}${what.slice(1)} copied.`)
    } catch {
      setCopied(`Couldn’t copy. Select the ${what} and copy it.`)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={tokenId} className="block text-sm font-medium">
          Token
        </label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            id={tokenId}
            readOnly
            value={created.token}
            onFocus={(e) => e.currentTarget.select()}
            className={`${inputClass.replace('mt-1 ', '')} min-w-0 flex-1 font-mono`}
          />
          <button
            ref={copyRef}
            type="button"
            className={`${secondaryButton} inline-flex items-center gap-1`}
            onClick={() => void copy(created.token, 'token')}
          >
            <Copy aria-hidden="true" className="size-4" />
            Copy token
          </button>
        </div>
      </div>
      <div>
        <label htmlFor={configId} className="block text-sm font-medium">
          MCP client configuration
        </label>
        <p className="text-sm text-ink/80">
          Add this server to your MCP client’s settings, such as Claude Desktop or Cursor. It includes the token.
        </p>
        <textarea
          id={configId}
          readOnly
          value={config}
          rows={config.split('\n').length + 1}
          onFocus={(e) => e.currentTarget.select()}
          className={`${inputClass} resize-none font-mono text-xs`}
        />
        <button
          type="button"
          className={`${secondaryButton} mt-2 inline-flex items-center gap-1`}
          onClick={() => void copy(config, 'configuration')}
        >
          <Copy aria-hidden="true" className="size-4" />
          Copy configuration
        </button>
      </div>
      <p role="status" className="min-h-5 text-sm font-medium text-status-g">
        {copied}
      </p>
      <div className="flex justify-end">
        <button type="button" className={primaryButton} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}

/** Create, then show the secret once. Closing the dialog drops it. */
function CreateTokenDialog({ triggerRef }: { triggerRef: RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<CreatedAccessToken | null>(null)

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) setCreated(null)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <button ref={triggerRef} type="button" className={primaryButton}>
          Create token
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          // A stray click outside would lose a secret that cannot be shown again.
          onPointerDownOutside={(e) => {
            if (created) e.preventDefault()
          }}
          className={`${dialogClass} w-[min(94vw,44rem)]`}
        >
          <Dialog.Title className="pr-8 text-lg font-semibold text-accent-deep">
            {created ? 'Copy your token' : 'Create token'}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-ink/80">
            {created
              ? `This is the token for “${created.name}”. Copy it now and keep it secret, like a password. You won’t be able to see it again.`
              : 'A token acts as you, with your current role and scope, from scripts and MCP clients.'}
          </Dialog.Description>
          <div className="mt-4">
            {open &&
              (created ? (
                <TokenReveal created={created} onDone={() => onOpenChange(false)} />
              ) : (
                <CreateTokenForm onCreated={setCreated} close={() => onOpenChange(false)} />
              ))}
          </div>
          <Dialog.Close asChild>
            <button type="button" aria-label="Close" className="absolute right-3 top-3 rounded-md p-1 hover:bg-cream">
              <X aria-hidden="true" className="size-5" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function RevokeConfirm({ token, onRevoked }: { token: AccessToken; onRevoked: () => void }) {
  const remove = useDeleteToken()
  const [errors, setErrors] = useState<string[]>([])

  async function revoke() {
    setErrors([])
    try {
      await remove.mutateAsync(token.id)
      onRevoked()
    } catch (err) {
      setErrors(unclaimed(errorsFrom(err), []))
    }
  }

  return (
    <>
      <div className="mt-4">
        <FormError messages={errors} />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Dialog.Close asChild>
          <button type="button" className={secondaryButton}>
            Cancel
          </button>
        </Dialog.Close>
        <button type="button" className={dangerButton} disabled={remove.isPending} onClick={() => void revoke()}>
          {remove.isPending ? 'Revoking…' : 'Revoke token'}
        </button>
      </div>
    </>
  )
}

export function AccessTokensPage() {
  const tokens = useMyTokens()
  const createRef = useRef<HTMLButtonElement>(null)
  const [notice, setNotice] = useState('')
  const [revoking, setRevoking] = useState<AccessToken | null>(null)
  const revokeTrigger = useRef<HTMLButtonElement | null>(null)
  const revoked = useRef(false)
  const loadedAt = tokens.dataUpdatedAt

  function startRevoke(token: AccessToken, trigger: HTMLButtonElement) {
    revokeTrigger.current = trigger
    revoked.current = false
    setRevoking(token)
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink/80">My settings</p>
          <h1 className="text-2xl font-semibold text-accent-deep">Access tokens</h1>
          <p className="mt-1 max-w-prose text-sm text-ink/80">
            Use a token to call the API from a script or to connect an MCP client. It acts as you, with your current
            role and scope. You can have up to 10 active tokens.
          </p>
        </div>
        <CreateTokenDialog triggerRef={createRef} />
      </div>
      <p role="status" className="min-h-5 text-sm font-medium text-status-g">
        {notice}
      </p>
      <QueryState isPending={tokens.isPending} error={tokens.error} what="access tokens" />
      {tokens.data?.length === 0 && <p className="text-sm">You have no access tokens yet.</p>}
      {tokens.data && tokens.data.length > 0 && (
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Access tokens</caption>
          <thead>
            <tr className="border-b border-ink/30">
              <th scope="col" className="py-2 pr-4 font-semibold">Name</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Prefix</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Created</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Expires</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Last used</th>
              <th scope="col" className="py-2 font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tokens.data.map((t) => (
              <tr key={t.id} className="border-b border-ink/10 align-top">
                <th scope="row" className="py-2 pr-4 font-medium">
                  {t.name}
                </th>
                <td className="py-2 pr-4">
                  <code className="font-mono">{t.prefix}…</code>
                </td>
                <td className="py-2 pr-4">{formatDate(t.createdAt)}</td>
                <td className="py-2 pr-4">
                  <span>{formatDate(t.expiresAt)}</span>
                  {Date.parse(t.expiresAt) <= loadedAt && (
                    <span className="ml-2 rounded-full bg-ink/10 px-2 py-0.5 text-xs font-semibold text-ink">
                      Expired
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4">{t.lastUsedAt ? formatDateTime(t.lastUsedAt) : 'Never'}</td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    aria-label={`Revoke ${t.name}`}
                    aria-haspopup="dialog"
                    className={secondaryButton}
                    onClick={(e) => startRevoke(t, e.currentTarget)}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog.Root open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
          <Dialog.Content
            role="alertdialog"
            onCloseAutoFocus={(e) => {
              // A revoked token's row (and its button) goes away.
              e.preventDefault()
              const target = revoked.current ? createRef.current : revokeTrigger.current
              target?.focus()
            }}
            className={`${dialogClass} w-[min(94vw,28rem)]`}
          >
            <Dialog.Title className="text-lg font-semibold text-accent-deep">Revoke {revoking?.name}?</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-ink/80">
              Anything using this token stops working right away. This can’t be undone.
            </Dialog.Description>
            {revoking && (
              <RevokeConfirm
                key={revoking.id}
                token={revoking}
                onRevoked={() => {
                  revoked.current = true
                  setNotice(`Revoked ${revoking.name}.`)
                  setRevoking(null)
                }}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}
