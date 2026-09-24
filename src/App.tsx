import { useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'

import './App.css'
import { getCurrentSession, signIn, signOut, subscribeToAuthChanges } from './lib/auth'
import { supabase } from './lib/supabase'
import type { Clinic, ClinicMembership, Patient } from './types/domain'

type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated' | 'error'

type MembershipContext = {
  clinic: Clinic
  membership: ClinicMembership
  user: User
}

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading')
  const [session, setSession] = useState<Session | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [membershipContext, setMembershipContext] = useState<MembershipContext | null>(null)
  const [membershipLoading, setMembershipLoading] = useState(false)
  const [membershipError, setMembershipError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    async function restoreSession() {
      const result = await getCurrentSession()
      if (!mounted) return
      if (result.error) {
        setAuthStatus('error')
        setAuthError('We could not restore your session. Please try again.')
        return
      }
      setSession(result.session)
      setMembershipLoading(Boolean(result.session))
      setMembershipError(null)
      setAuthStatus(result.session ? 'authenticated' : 'unauthenticated')
    }

    void restoreSession()
    const unsubscribe = subscribeToAuthChanges((_event, nextSession) => {
      if (!mounted) return
      setSession(nextSession)
      setAuthError(null)
      setMembershipError(null)
      setMembershipLoading(Boolean(nextSession))
      setAuthStatus(nextSession ? 'authenticated' : 'unauthenticated')
    })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (authStatus !== 'authenticated' || !session?.user || !supabase) {
      return
    }

    let cancelled = false
    const client = supabase
    const authenticatedUser = session.user

    async function loadMembership() {
      const { data: membershipRows, error: membershipQueryError } = await client
        .from('clinic_memberships')
        .select('user_id, clinic_id, role, created_at')
        .eq('user_id', authenticatedUser.id)
        .limit(1)

      if (cancelled) return
      if (membershipQueryError) {
        setMembershipLoading(false)
        setMembershipError('We could not load your clinic access. Please try again.')
        return
      }

      const membership = (membershipRows as ClinicMembership[])[0]
      if (!membership) {
        setMembershipContext(null)
        setMembershipLoading(false)
        return
      }

      const { data: clinicRow, error: clinicQueryError } = await client
        .from('clinics')
        .select('*')
        .eq('id', membership.clinic_id)
        .single()

      if (cancelled) return
      setMembershipLoading(false)
      if (clinicQueryError) {
        setMembershipError('We could not load your clinic. Please try again.')
        return
      }
      setMembershipContext({ clinic: clinicRow as Clinic, membership, user: authenticatedUser })
    }

    void loadMembership()
    return () => {
      cancelled = true
    }
  }, [authStatus, session])

  if (authStatus === 'loading') return <StatusScreen message="Loading your session..." />
  if (authStatus === 'error') return <StatusScreen message={authError ?? 'Authentication is temporarily unavailable.'} />
  if (authStatus === 'unauthenticated') return <LoginScreen error={authError} onError={setAuthError} />
  if (membershipLoading) return <StatusScreen message="Loading your clinic..." />
  if (membershipError) return <StatusScreen message={membershipError} action={<button onClick={() => window.location.reload()}>Try again</button>} />
  if (!membershipContext) return <ClinicSetupScreen user={session!.user} />

  return <ClinicShell context={membershipContext} />
}

function LoginScreen({ error, onError }: { error: string | null; onError: (value: string | null) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    onError(null)
    const result = await signIn(email.trim(), password)
    setSubmitting(false)
    if (result.error) onError('Sign-in failed. Check your email and password.')
    else setPassword('')
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">SmartDental HMIS</p>
        <h1>Welcome back</h1>
        <p className="panel-copy">Sign in to continue to your clinic workspace.</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          <button type="submit" disabled={submitting}>{submitting ? 'Signing in...' : 'Sign in'}</button>
        </form>
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
    </main>
  )
}

function ClinicSetupScreen({ user }: { user: User }) {
  const [clinicName, setClinicName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = clinicName.trim()
    if (name.length < 1 || name.length > 200) {
      setError('Enter a clinic name between 1 and 200 characters.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }

    setSubmitting(true)
    setError(null)
    const { error: bootstrapError } = await supabase.rpc('bootstrap_clinic', { p_name: name } as never)
    setSubmitting(false)
    if (bootstrapError) {
      setError('We could not create your clinic. Please try again.')
      return
    }
    window.location.reload()
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">SmartDental HMIS</p>
        <h1>Set up your clinic</h1>
        <p className="panel-copy">Create the clinic workspace for {user.email ?? 'your account'}.</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>Clinic name<input value={clinicName} onChange={(event) => setClinicName(event.target.value)} autoComplete="organization" maxLength={200} required /></label>
          <button type="submit" disabled={submitting}>{submitting ? 'Creating clinic...' : 'Create clinic'}</button>
        </form>
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
    </main>
  )
}

function ClinicShell({ context }: { context: MembershipContext }) {
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [activeModule, setActiveModule] = useState('Dashboard')

  async function handleLogout() {
    const error = await signOut()
    if (error) setLogoutError('Sign-out failed. Please try again.')
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div><p className="eyebrow">SmartDental HMIS</p><p className="clinic-name">{context.clinic.name}</p></div>
        <nav aria-label="Clinic modules">
          {['Dashboard', 'Appointments', 'Clinical Visits', 'Billing', 'Prescriptions', 'Investigations'].map((item) => <span className={`nav-item${activeModule === item ? ' active' : ''}`} key={item}>{item}</span>)}
          <button className={`nav-item nav-button${activeModule === 'Patients' ? ' active' : ''}`} onClick={() => setActiveModule('Patients')} type="button">Patients</button>
        </nav>
        <div className="user-area"><p>{context.user.email ?? 'Signed-in user'}</p><p className="role">{context.membership.role}</p><button className="button-secondary" onClick={handleLogout}>Log out</button>{logoutError && <p className="form-error" role="alert">{logoutError}</p>}</div>
      </aside>
      <section className="shell-content">
        {activeModule === 'Patients' ? <PatientsView /> : <><p className="eyebrow">Clinic workspace</p><h1>{context.clinic.name}</h1><p className="panel-copy">Your clinic workspace is ready.</p></>}
      </section>
    </main>
  )
}

function PatientsView() {
  const [patients, setPatients] = useState<Patient[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadPatients() {
      if (!supabase) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }

      const { data, error: queryError } = await supabase
        .from('patients')
        .select('id, clinic_id, patient_number, first_name, middle_name, last_name, gender, date_of_birth, phone, created_at')
        .order('created_at', { ascending: false })

      if (cancelled) return
      setLoading(false)
      if (queryError) {
        setError('We could not load patients. Please try again.')
        return
      }
      setPatients((data ?? []) as Patient[])
    }

    void loadPatients()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="patients-page">
      <div className="page-heading">
        <div><p className="eyebrow">Patient management</p><h1>Patients</h1><p className="panel-copy">View the patients in your clinic.</p></div>
        <button className="primary-action" disabled type="button">Register New Patient</button>
      </div>
      {loading && <div className="state-panel" role="status">Loading patients...</div>}
      {!loading && error && <div className="state-panel state-error" role="alert">{error}</div>}
      {!loading && !error && patients.length === 0 && <div className="state-panel"><h2>No patients yet</h2><p>Registered patients will appear here.</p></div>}
      {!loading && !error && patients.length > 0 && <PatientTable patients={patients} />}
    </div>
  )
}

function PatientTable({ patients }: { patients: Patient[] }) {
  return (
    <div className="table-frame">
      <table className="patient-table">
        <thead><tr><th>Patient number</th><th>Full name</th><th>Gender</th><th>Date of birth</th><th>Phone</th><th>Created</th></tr></thead>
        <tbody>{patients.map((patient) => <tr key={patient.id}><td>{patient.patient_number}</td><td>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</td><td>{patient.gender || '-'}</td><td>{formatDate(patient.date_of_birth)}</td><td>{patient.phone || '-'}</td><td>{formatDate(patient.created_at)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value))
}

function StatusScreen({ message, action }: { message: string; action?: React.ReactNode }) {
  return <main className="auth-page"><section className="auth-panel"><p className="eyebrow">SmartDental HMIS</p><p className="panel-copy">{message}</p>{action}</section></main>
}

export default App
