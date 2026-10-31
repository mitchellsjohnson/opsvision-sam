import { useId, useState, type FormEvent } from 'react'
import {
  useInviteMember,
  useMembers,
  useOrgLevels,
  useOrgUnits,
  usePublishedMetrics,
  useUpdateMember,
  type Membership,
} from '../../api/queries'
import {
  NO_ERRORS,
  errorsFrom,
  fieldError,
  forField,
  isPending,
  scopeSummary,
  unclaimed,
  type FormErrors,
} from './adminModel'
import {
  FieldMessages,
  FormActions,
  FormDialog,
  FormError,
  QueryState,
  SelectField,
  TextField,
  primaryButton,
  inputClass,
  useFocusOnError,
} from './formUi'
import { ScopeEditor, type ScopeValue } from './ScopeEditor'

type Role = Membership['role']

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'contributor', label: 'Contributor' },
  { value: 'viewer', label: 'Viewer' },
]

/** A simple address check, matching the API's: something@something.something, no spaces. */
const EMAIL_PATTERN = /^[^\s@#]+@[^\s@#]+\.[^\s@#]+$/

/** What to call a member: their name, or the email of an invitation that has no name yet. */
function displayName(m: Membership): string {
  return m.name.trim() || m.email || m.userId
}

/** Org units, levels and the published metrics, loaded once for the scope editors. */
function useScopeData() {
  const units = useOrgUnits()
  const levels = useOrgLevels()
  const metrics = usePublishedMetrics()
  return { units, levels, metrics }
}

type ScopeData = ReturnType<typeof useScopeData>

function ScopePicker({
  data,
  value,
  onChange,
  errors,
}: {
  data: ScopeData
  value: ScopeValue
  onChange: (next: ScopeValue) => void
  errors: FormErrors
}) {
  if (data.units.isPending || data.levels.isPending) return <p role="status">Loading org units…</p>
  if (data.units.isError || data.levels.isError) {
    return <p role="alert" className="font-medium text-status-r">Could not load org units.</p>
  }
  return (
    <ScopeEditor
      value={value}
      onChange={onChange}
      units={data.units.data.units}
      levels={data.levels.data}
      metrics={data.metrics.data}
      metricsPending={data.metrics.isPending}
      metricsFailed={data.metrics.isError}
      errors={errors}
    />
  )
}

function EditScopeForm({
  member,
  data,
  onSaved,
  close,
}: {
  member: Membership
  data: ScopeData
  onSaved: (message: string) => void
  close: () => void
}) {
  const update = useUpdateMember()
  const { formRef, focusErrors } = useFocusOnError()
  const [scope, setScope] = useState<ScopeValue>({
    orgUnitIds: [...member.scope.orgUnitIds],
    metricKeys: [...member.scope.metricKeys],
  })
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await update.mutateAsync({ userId: member.userId, body: { scope } })
      onSaved(`Saved the scope of ${displayName(member)}.`)
      close()
    } catch (err) {
      setErrors(errorsFrom(err))
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <ScopePicker data={data} value={scope} onChange={setScope} errors={errors} />
      <FormError messages={unclaimed(errors, ['scope.orgUnitIds', 'scope.metricKeys'])} />
      <FormActions submitLabel="Save scope" pending={update.isPending} onCancel={close} />
    </form>
  )
}

function InviteForm({
  data,
  onInvited,
  close,
}: {
  data: ScopeData
  onInvited: (message: string) => void
  close: () => void
}) {
  const invite = useInviteMember()
  const { formRef, focusErrors } = useFocusOnError()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [scope, setScope] = useState<ScopeValue>({ orgUnitIds: [], metricKeys: [] })
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const address = email.trim()
    if (!EMAIL_PATTERN.test(address)) {
      setErrors(fieldError('email', 'Enter a valid email address, such as name@example.com.'))
      focusErrors()
      return
    }
    try {
      await invite.mutateAsync({ email: address, role, scope })
      onInvited(`Invited ${address}.`)
      close()
    } catch (err) {
      const mapped = errorsFrom(err)
      // A duplicate address is a conflict with no field: it is about the email.
      setErrors(
        mapped.fields.email || mapped.general.length === 0
          ? mapped
          : { fields: { ...mapped.fields, email: mapped.general }, general: [] },
      )
      focusErrors()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
      <TextField
        label="Email"
        type="email"
        autoComplete="off"
        hint="They get this role and scope when they first sign in with this address."
        value={email}
        errors={forField(errors, 'email')}
        onChange={(e) => setEmail(e.target.value)}
      />
      <SelectField
        label="Role"
        value={role}
        options={ROLE_OPTIONS}
        errors={forField(errors, 'role')}
        onChange={(e) => setRole(e.target.value as Role)}
      />
      <ScopePicker data={data} value={scope} onChange={setScope} errors={errors} />
      <FormError messages={unclaimed(errors, ['email', 'role', 'scope.orgUnitIds', 'scope.metricKeys'])} />
      <FormActions submitLabel="Send invitation" pending={invite.isPending} onCancel={close} />
    </form>
  )
}

function RoleSelect({
  member,
  errors,
  pending,
  onChange,
}: {
  member: Membership
  errors: readonly string[]
  pending: boolean
  onChange: (role: Role) => void
}) {
  const errId = useId()
  return (
    <>
      <select
        aria-label={`Role for ${displayName(member)}`}
        className={inputClass.replace('mt-1 ', '') + ' w-auto'}
        value={member.role}
        disabled={pending}
        aria-invalid={errors.length > 0 ? true : undefined}
        aria-describedby={errors.length > 0 ? errId : undefined}
        onChange={(e) => onChange(e.target.value as Role)}
      >
        {ROLE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldMessages id={errId} errors={errors} />
    </>
  )
}

export function MembersPage() {
  const members = useMembers()
  const data = useScopeData()
  const update = useUpdateMember()
  const [notice, setNotice] = useState('')
  const [roleErrors, setRoleErrors] = useState<Record<string, string[]>>({})
  const [changing, setChanging] = useState<string | null>(null)

  const unitNames = new Map((data.units.data?.units ?? []).map((u) => [u.id, u.name]))
  const metricNames = new Map((data.metrics.data ?? []).map((m) => [m.key, m.name]))

  async function changeRole(m: Membership, role: Role) {
    setChanging(m.userId)
    setRoleErrors({}) // a new attempt replaces any earlier message
    try {
      await update.mutateAsync({ userId: m.userId, body: { role } })
      setNotice(`${displayName(m)} is now ${role === 'admin' ? 'an admin' : `a ${role}`}.`)
    } catch (err) {
      const e = errorsFrom(err)
      setRoleErrors((prev) => ({ ...prev, [m.userId]: [...e.general, ...Object.values(e.fields).flat()] }))
    } finally {
      setChanging(null)
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-accent-deep">Members</h1>
        <FormDialog
          triggerLabel="Invite member"
          triggerClassName={primaryButton}
          title="Invite member"
          description="Add someone by email. Their access starts when they first sign in with that address."
          wide
        >
          {(close) => <InviteForm data={data} onInvited={setNotice} close={close} />}
        </FormDialog>
      </div>
      <p role="status" className="min-h-5 text-sm font-medium text-status-g">
        {notice}
      </p>
      <QueryState isPending={members.isPending} error={members.error} what="members" />
      {members.data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
            <caption className="sr-only">Members</caption>
            <thead>
              <tr className="border-b border-ink/30">
                <th scope="col" className="py-2 pr-4 font-semibold">Member</th>
                <th scope="col" className="py-2 pr-4 font-semibold">Role</th>
                <th scope="col" className="py-2 pr-4 font-semibold">Scope</th>
                <th scope="col" className="py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.data.map((m) => (
                <tr key={m.userId} className="border-b border-ink/10 align-top">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{displayName(m)}</span>
                      {isPending(m.userId) && (
                        <span className="rounded-full bg-status-y-bg px-2 py-0.5 text-xs font-semibold text-status-y">
                          Invited
                        </span>
                      )}
                    </span>
                    {m.name.trim() && <span className="block text-ink/80">{m.email}</span>}
                    {!m.name.trim() && isPending(m.userId) && (
                      <span className="block text-ink/80">Has not signed in yet</span>
                    )}
                  </th>
                  <td className="py-2 pr-4">
                    <RoleSelect
                      member={m}
                      errors={roleErrors[m.userId] ?? []}
                      pending={changing === m.userId}
                      onChange={(role) => void changeRole(m, role)}
                    />
                  </td>
                  <td className="py-2 pr-4">{scopeSummary(m.scope, unitNames, metricNames)}</td>
                  <td className="py-2">
                    <FormDialog
                      triggerLabel="Edit scope"
                      triggerAriaLabel={`Edit scope for ${displayName(m)}`}
                      title={`Scope for ${displayName(m)}`}
                      description="Choose which org units and metrics this person can see and edit. Leave a list empty for everything."
                      wide
                    >
                      {(close) => <EditScopeForm member={m} data={data} onSaved={setNotice} close={close} />}
                    </FormDialog>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
