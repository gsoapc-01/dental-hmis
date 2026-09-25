import { useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'

import './App.css'
import { getCurrentSession, signIn, signOut, subscribeToAuthChanges } from './lib/auth'
import { supabase } from './lib/supabase'
import type { Appointment, Clinic, ClinicMembership, Patient, UserRole, Visit } from './types/domain'

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
        <div className="brand-lockup"><div className="brand-mark">SD</div><div><p className="eyebrow">SmartDental</p><p className="clinic-name">{context.clinic.name}</p></div></div>
        <nav aria-label="Clinic modules">
          <p className="nav-label">Workspace</p>
          {['Dashboard', 'Clinical Visits'].map((item) => <span className={`nav-item${activeModule === item ? ' active' : ''}`} key={item}><span className="nav-dot" />{item}</span>)}
          <button className={`nav-item nav-button${activeModule === 'Appointments' ? ' active' : ''}`} onClick={() => setActiveModule('Appointments')} type="button"><span className="nav-dot" />Appointments</button>
          <p className="nav-label nav-label-spaced">Management</p>
          {['Billing', 'Prescriptions', 'Investigations'].map((item) => <span className={`nav-item${activeModule === item ? ' active' : ''}`} key={item}><span className="nav-dot" />{item}</span>)}
          <button className={`nav-item nav-button${activeModule === 'Patients' ? ' active' : ''}`} onClick={() => setActiveModule('Patients')} type="button"><span className="nav-dot" />Patients</button>
        </nav>
        <div className="user-area"><div className="user-summary"><div className="avatar">{(context.user.email?.[0] ?? 'U').toUpperCase()}</div><div><p>{context.user.email ?? 'Signed-in user'}</p><p className="role">{context.membership.role}</p></div></div><button className="button-secondary" onClick={handleLogout}>Log out</button>{logoutError && <p className="form-error" role="alert">{logoutError}</p>}</div>
      </aside>
      <section className="shell-content">
        <header className="topbar"><div><p className="topbar-kicker">Clinic workspace</p><p className="topbar-title">{activeModule}</p></div><div className="topbar-meta"><span className="status-indicator" />Secure session</div></header>
        {activeModule === 'Appointments' ? <AppointmentsView clinicId={context.clinic.id} userId={context.user.id} role={context.membership.role} /> : activeModule === 'Patients' ? <PatientsView clinicId={context.clinic.id} userId={context.user.id} role={context.membership.role} clinicianLabel={context.user.email ?? context.membership.role} /> : <DashboardView clinicName={context.clinic.name} onOpenPatients={() => setActiveModule('Patients')} />}
      </section>
    </main>
  )
}

function DashboardView({ clinicName, onOpenPatients }: { clinicName: string; onOpenPatients: () => void }) {
  return (
    <div className="dashboard-page">
      <div className="dashboard-intro"><div><p className="eyebrow">Good to see you</p><h1>{clinicName}</h1><p className="panel-copy">Your clinic workspace is ready for today.</p></div><button className="primary-action" onClick={onOpenPatients} type="button">Open patient list</button></div>
      <div className="summary-grid"><section className="summary-card summary-card-accent"><p className="card-label">Patients</p><p className="card-value">Active workspace</p><p className="card-note">Manage registrations from the patient list.</p></section><section className="summary-card"><p className="card-label">Appointments</p><p className="card-value">Coming soon</p><p className="card-note">Appointment workflows are not enabled yet.</p></section><section className="summary-card"><p className="card-label">Clinical visits</p><p className="card-value">Coming soon</p><p className="card-note">Clinical documentation will appear here.</p></section></div>
      <section className="dashboard-panel"><div><p className="eyebrow">Workspace status</p><h2>Everything is ready</h2><p className="panel-copy">Use Patients to register and review the people receiving care at {clinicName}.</p></div><span className="ready-badge"><span className="status-indicator" />Operational</span></section>
    </div>
  )
}

type DoctorOption = {
  id: string
  name: string
}

type PatientAppointmentSummary = {
  id: string
  patient_number: string
  first_name: string
  middle_name?: string | null
  last_name: string
}

async function loadDoctorOptions(clinicId: string): Promise<{ doctors: DoctorOption[]; error: string | null }> {
  if (!supabase) return { doctors: [], error: 'Supabase is not configured.' }

  const { data: membershipRows, error: membershipError } = await supabase
    .from('clinic_memberships')
    .select('user_id, clinic_id, role, created_at')
    .eq('clinic_id', clinicId)
    .eq('role', 'doctor')

  if (membershipError) return { doctors: [], error: 'We could not load the clinic doctor directory.' }
  const doctorIds = (membershipRows as ClinicMembership[]).map((membership) => membership.user_id)
  if (doctorIds.length === 0) return { doctors: [], error: 'No doctors are available in this clinic.' }

  const { data: profileRows, error: profileError } = await supabase
    .from('profiles')
    .select('id, display_name')
    .in('id', doctorIds)

  if (profileError) return { doctors: [], error: 'We could not load doctor names for this clinic.' }
  const profiles = (profileRows ?? []) as Array<{ id: string; display_name?: string | null }>
  return {
    doctors: doctorIds.map((id) => ({
      id,
      name: profiles.find((profile) => profile.id === id)?.display_name?.trim() || 'Clinic doctor',
    })),
    error: null,
  }
}

type AppointmentView = 'upcoming' | 'today' | 'waiting'

function AppointmentsView({ clinicId, userId, role }: { clinicId: string; userId: string; role: UserRole }) {
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [waitingAppointments, setWaitingAppointments] = useState<Appointment[]>([])
  const [patients, setPatients] = useState<Record<string, PatientAppointmentSummary>>({})
  const [doctors, setDoctors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<AppointmentView>('upcoming')
  const [transitioningId, setTransitioningId] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function loadAppointments() {
      if (!supabase) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }

      setLoading(true)
      setTransitionError(null)
      const today = new Date().toISOString().slice(0, 10)
      const [appointmentResult, waitingResult, patientResult, doctorResult] = await Promise.all([
        supabase.from('appointments').select('*').eq('clinic_id', clinicId).gte('appointment_date', today).order('appointment_date', { ascending: true }).order('start_time', { ascending: true }),
        supabase.from('appointments').select('*').eq('clinic_id', clinicId).eq('status', 'waiting').order('appointment_date', { ascending: true }).order('start_time', { ascending: true }),
        supabase.from('patients').select('id, patient_number, first_name, middle_name, last_name').eq('clinic_id', clinicId),
        loadDoctorOptions(clinicId),
      ])

      if (cancelled) return
      setLoading(false)
      if (appointmentResult.error || waitingResult.error || patientResult.error) {
        setError(appointmentResult.error || waitingResult.error ? 'We could not load appointments.' : 'We could not load appointment patient details.')
        return
      }

      const patientMap = Object.fromEntries(((patientResult.data ?? []) as PatientAppointmentSummary[]).map((patient) => [patient.id, patient]))
      const doctorMap = Object.fromEntries(doctorResult.doctors.map((doctor) => [doctor.id, doctor.name]))
      setAppointments((appointmentResult.data ?? []) as Appointment[])
      setWaitingAppointments((waitingResult.data ?? []) as Appointment[])
      setPatients(patientMap)
      setDoctors(doctorMap)
      if (doctorResult.error) setTransitionError(doctorResult.error)
    }

    void loadAppointments()
    return () => {
      cancelled = true
    }
  }, [clinicId, refreshVersion])

  const today = new Date().toISOString().slice(0, 10)
  const todayAppointments = appointments.filter((appointment) => appointment.appointment_date === today)
  const visibleWaitingAppointments = waitingAppointments.filter((appointment) => role !== 'doctor' || appointment.doctor_id === userId)
  const displayedAppointments = activeView === 'today' ? todayAppointments : activeView === 'waiting' ? visibleWaitingAppointments : appointments
  const hasAppointments = appointments.length > 0 || visibleWaitingAppointments.length > 0

  async function transitionAppointment(appointment: Appointment, nextStatus: 'arrived' | 'waiting') {
    const expectedStatus = nextStatus === 'arrived' ? ['scheduled', 'confirmed'] : ['arrived']
    if (!expectedStatus.includes(appointment.status)) return
    if (!supabase) {
      setTransitionError('Supabase is not configured.')
      return
    }

    setTransitioningId(appointment.id)
    setTransitionError(null)
    const { error: updateError } = await supabase
      .from('appointments')
      .update({ status: nextStatus } as never)
      .eq('id', appointment.id)
      .eq('clinic_id', clinicId)
      .in('status', expectedStatus)
    setTransitioningId(null)
    if (updateError) {
      setTransitionError('We could not update the appointment status. Please refresh and try again.')
      return
    }
    setRefreshVersion((version) => version + 1)
  }

  return (
    <div className="appointments-page">
      <div className="page-heading"><div><p className="eyebrow">Care coordination</p><h1>Appointments</h1><p className="panel-copy">Schedule and manage today\'s patient arrivals.</p></div><button className="button-secondary refresh-button" onClick={() => setRefreshVersion((version) => version + 1)} type="button">Refresh</button></div>
      <div className="appointment-tabs" role="tablist" aria-label="Appointment views"><button className={activeView === 'upcoming' ? 'active' : ''} onClick={() => setActiveView('upcoming')} role="tab" type="button">Upcoming <span>{appointments.length}</span></button><button className={activeView === 'today' ? 'active' : ''} onClick={() => setActiveView('today')} role="tab" type="button">Today <span>{todayAppointments.length}</span></button><button className={activeView === 'waiting' ? 'active' : ''} onClick={() => setActiveView('waiting')} role="tab" type="button">Waiting queue <span>{visibleWaitingAppointments.length}</span></button></div>
      {loading && <div className="state-panel" role="status">Loading upcoming appointments...</div>}
      {!loading && error && <div className="state-panel state-error" role="alert">{error}</div>}
      {!loading && !error && transitionError && <div className="state-panel state-error" role="alert">{transitionError}</div>}
      {!loading && !error && !hasAppointments && <div className="state-panel"><h2>No upcoming appointments</h2><p>Appointments booked from patient files will appear here.</p></div>}
      {!loading && !error && hasAppointments && displayedAppointments.length === 0 && <div className="state-panel"><h2>{activeView === 'waiting' ? 'No patients waiting' : activeView === 'today' ? 'No appointments today' : 'No upcoming appointments'}</h2><p>{activeView === 'waiting' ? 'Patients sent to waiting will appear here.' : 'Appointments booked from patient files will appear here.'}</p></div>}
      {!loading && !error && displayedAppointments.length > 0 && <div className="appointment-list">{displayedAppointments.map((appointment) => <AppointmentCard key={appointment.id} appointment={appointment} patient={patients[appointment.patient_id]} doctorName={doctors[appointment.doctor_id ?? '']} onTransition={transitionAppointment} transitioning={transitioningId === appointment.id} />)}</div>}
    </div>
  )
}

function AppointmentCard({ appointment, patient, doctorName, onTransition, transitioning }: { appointment: Appointment; patient?: PatientAppointmentSummary; doctorName?: string; onTransition: (appointment: Appointment, nextStatus: 'arrived' | 'waiting') => void; transitioning: boolean }) {
  const canCheckIn = appointment.status === 'scheduled' || appointment.status === 'confirmed'
  const canSendToWaiting = appointment.status === 'arrived'

  return <article className="appointment-card"><div className="appointment-date-block"><span>{formatDate(appointment.appointment_date)}</span><strong>{formatTime(appointment.start_time)}</strong><small>{formatTime(appointment.end_time)}</small></div><div className="appointment-main"><p className="appointment-patient">{patient ? [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ') : 'Patient unavailable'}</p><p className="appointment-file">File {patient?.patient_number ?? '-'}</p>{appointment.service && <p className="appointment-reason">{appointment.service}</p>}</div><div className="appointment-meta"><p>{doctorName ?? 'Doctor unavailable'}</p><span className={`appointment-status status-${appointment.status}`}>{formatStatus(appointment.status)}</span><div className="appointment-actions">{canCheckIn && <button onClick={() => onTransition(appointment, 'arrived')} disabled={transitioning} type="button">{transitioning ? 'Updating...' : 'Check In'}</button>}{canSendToWaiting && <button onClick={() => onTransition(appointment, 'waiting')} disabled={transitioning} type="button">{transitioning ? 'Updating...' : 'Send to Waiting'}</button>}</div></div></article>
}

type PatientFormValues = {
  first_name: string
  middle_name: string
  last_name: string
  gender: string
  date_of_birth: string
  approximate_age_years: string
  phone: string
  email: string
  address: string
}

const initialPatientForm: PatientFormValues = {
  first_name: '',
  middle_name: '',
  last_name: '',
  gender: '',
  date_of_birth: '',
  approximate_age_years: '',
  phone: '',
  email: '',
  address: '',
}

function PatientsView({ clinicId, userId, role, clinicianLabel }: { clinicId: string; userId: string; role: UserRole; clinicianLabel: string }) {
  const [patients, setPatients] = useState<Patient[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [showRegistration, setShowRegistration] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)

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
        .select('*')
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
  }, [refreshVersion])

  const normalizedSearch = searchTerm.trim().toLowerCase()
  const visiblePatients = patients.filter((patient) => {
    if (!normalizedSearch) return true
    return [patient.patient_number, patient.first_name, patient.middle_name, patient.last_name, patient.phone]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalizedSearch))
  })

  function handleRegistered(patient: Patient) {
    setShowRegistration(false)
    setSuccess(`Patient file ${patient.patient_number} was registered successfully.`)
    setRefreshVersion((version) => version + 1)
  }

  function handlePatientUpdated(updatedPatient: Patient) {
    setPatients((current) => current.map((patient) => patient.id === updatedPatient.id ? updatedPatient : patient))
    setSelectedPatient(updatedPatient)
    setSuccess('Patient details updated successfully.')
    setRefreshVersion((version) => version + 1)
  }

  return (
    <div className="patients-page">
      <div className="page-heading">
        <div><p className="eyebrow">Patient management</p><h1>{selectedPatient ? 'Patient details' : 'Patients'}</h1><p className="panel-copy">{selectedPatient ? 'Review and update demographic information.' : 'Register and review the people receiving care at your clinic.'}</p></div>
        {!showRegistration && <button className="primary-action" onClick={() => { setSuccess(null); setError(null); setShowRegistration(true) }} type="button">Register New Patient</button>}
      </div>
      {success && <div className="state-panel state-success" role="status">{success}</div>}
      {showRegistration && <PatientRegistrationForm clinicId={clinicId} onCancel={() => setShowRegistration(false)} onRegistered={handleRegistered} />}
      {selectedPatient && <PatientProfile clinicId={clinicId} userId={userId} role={role} clinicianLabel={clinicianLabel} patient={selectedPatient} onBack={() => setSelectedPatient(null)} onUpdated={handlePatientUpdated} />}
      {!selectedPatient && <>
        <div className="patient-toolbar"><label className="search-field"><span>Search patients</span><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="File number, name, or phone" type="search" /></label><p className="result-count">{loading ? 'Loading...' : `${visiblePatients.length} ${visiblePatients.length === 1 ? 'patient' : 'patients'}`}</p></div>
        {loading && <div className="state-panel" role="status">Loading patients...</div>}
        {!loading && error && <div className="state-panel state-error" role="alert">{error}</div>}
        {!loading && !error && patients.length === 0 && <div className="state-panel"><h2>No patients yet</h2><p>Registered patients will appear here.</p></div>}
        {!loading && !error && patients.length > 0 && visiblePatients.length === 0 && <div className="state-panel"><h2>No matching patients</h2><p>Try a different file number, name, or phone number.</p></div>}
        {!loading && !error && visiblePatients.length > 0 && <PatientTable patients={visiblePatients} onSelect={setSelectedPatient} />}
      </>}
    </div>
  )
}

function PatientRegistrationForm({ clinicId, onCancel, onRegistered }: { clinicId: string; onCancel: () => void; onRegistered: (patient: Patient) => void }) {
  const [form, setForm] = useState<PatientFormValues>(initialPatientForm)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updateField(field: keyof PatientFormValues, value: string) {
    setForm((current) => ({
      ...current,
      [field]: value,
      ...(field === 'date_of_birth' && value ? { approximate_age_years: '' } : {}),
      ...(field === 'approximate_age_years' && value ? { date_of_birth: '' } : {}),
    }))
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const firstName = form.first_name.trim()
    const lastName = form.last_name.trim()
    const email = form.email.trim()
    const ageInput = form.approximate_age_years.trim()
    const approximateAge = ageInput ? Number(ageInput) : null

    if (!firstName || !lastName || !form.gender) {
      setError('First name, last name, and gender are required.')
      return
    }
    if (email && !isValidEmail(email)) {
      setError('Enter a valid email address or leave email blank.')
      return
    }
    if (approximateAge !== null && (!Number.isInteger(approximateAge) || approximateAge < 0 || approximateAge > 130)) {
      setError('Approximate age must be a whole number between 0 and 130.')
      return
    }
    if (form.date_of_birth && ageInput) {
      setError('Enter either a date of birth or an approximate age, not both.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }

    setSubmitting(true)
    setError(null)
    const { data: insertedPatient, error: insertError } = await supabase.from('patients').insert({
      clinic_id: clinicId,
      first_name: firstName,
      middle_name: form.middle_name.trim() || null,
      last_name: lastName,
      gender: form.gender.trim() || null,
      date_of_birth: form.date_of_birth || null,
      approximate_age_years: approximateAge,
      phone: form.phone.trim() || null,
      email: email || null,
      address: form.address.trim() || null,
    } as never).select('*').single()
    setSubmitting(false)
    if (insertError) {
      setError(insertError.code === '23505' ? 'That patient number is already in use in this clinic.' : 'We could not register the patient. Please try again.')
      return
    }
    if (!insertedPatient) {
      setError('The patient was saved, but we could not load the generated file number. Please refresh and try again.')
      return
    }
    onRegistered(insertedPatient as Patient)
  }

  return (
    <section className="registration-panel" aria-labelledby="registration-heading">
      <div className="registration-heading"><div><p className="eyebrow">Patient management</p><h2 id="registration-heading">Register New Patient</h2><p className="panel-copy">Enter the minimum details needed to create a patient file.</p><p className="generated-number-note">Patient file number will be generated automatically.</p></div></div>
      <form className="patient-form" onSubmit={handleSubmit}>
        <label>First name<input value={form.first_name} onChange={(event) => updateField('first_name', event.target.value)} autoComplete="given-name" required /></label>
        <label>Middle name<input value={form.middle_name} onChange={(event) => updateField('middle_name', event.target.value)} autoComplete="additional-name" /></label>
        <label>Last name<input value={form.last_name} onChange={(event) => updateField('last_name', event.target.value)} autoComplete="family-name" required /></label>
        <label>Gender<select value={form.gender} onChange={(event) => updateField('gender', event.target.value)}><option value="">Select gender</option><option value="Male">Male</option><option value="Female">Female</option></select></label>
        <label>Date of birth<input type="date" value={form.date_of_birth} onChange={(event) => updateField('date_of_birth', event.target.value)} /></label>
        <label>Approximate age (years)<input type="number" min="0" max="130" step="1" value={form.approximate_age_years} onChange={(event) => updateField('approximate_age_years', event.target.value)} placeholder="Use if DOB is unknown" /></label>
        <label>Phone<input type="tel" value={form.phone} onChange={(event) => updateField('phone', event.target.value)} autoComplete="tel" /></label>
        <label>Email<input type="email" value={form.email} onChange={(event) => updateField('email', event.target.value)} autoComplete="email" /></label>
        <label className="full-width">Address<input value={form.address} onChange={(event) => updateField('address', event.target.value)} autoComplete="street-address" /></label>
        <div className="form-actions"><button className="button-secondary" onClick={onCancel} type="button">Cancel</button><button type="submit" disabled={submitting}>{submitting ? 'Saving patient...' : 'Save patient'}</button></div>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  )
}

function PatientTable({ patients, onSelect }: { patients: Patient[]; onSelect: (patient: Patient) => void }) {
  return (
    <div className="table-frame">
      <table className="patient-table">
        <thead><tr><th>Patient file</th><th>Full name</th><th>Gender</th><th>Date of birth</th><th>Phone</th><th>Registered</th></tr></thead>
        <tbody>{patients.map((patient) => <tr className="patient-row" key={patient.id} onClick={() => onSelect(patient)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(patient) }} role="button" tabIndex={0}><td><span className="file-number">{patient.patient_number}</span></td><td className="patient-name-cell">{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</td><td>{patient.gender || '-'}</td><td>{formatDate(patient.date_of_birth)}</td><td>{patient.phone || '-'}</td><td>{formatDate(patient.created_at)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

function PatientProfile({ clinicId, userId, role, clinicianLabel, patient, onBack, onUpdated }: { clinicId: string; userId: string; role: UserRole; clinicianLabel: string; patient: Patient; onBack: () => void; onUpdated: (patient: Patient) => void }) {
  const [editing, setEditing] = useState(false)
  const [visits, setVisits] = useState<Visit[]>([])
  const [visitLoading, setVisitLoading] = useState(true)
  const [visitError, setVisitError] = useState<string | null>(null)
  const [visitSuccess, setVisitSuccess] = useState<string | null>(null)
  const [showVisitForm, setShowVisitForm] = useState(false)
  const [visitRefreshVersion, setVisitRefreshVersion] = useState(0)
  const [showAppointmentForm, setShowAppointmentForm] = useState(false)
  const [appointmentSuccess, setAppointmentSuccess] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadVisits() {
      setVisitLoading(true)
      if (!supabase) {
        setVisitLoading(false)
        setVisitError('Supabase is not configured.')
        return
      }

      const { data, error: queryError } = await supabase
        .from('visits')
        .select('*')
        .eq('clinic_id', clinicId)
        .eq('patient_id', patient.id)
        .order('visit_date', { ascending: false })

      if (cancelled) return
      setVisitLoading(false)
      if (queryError) {
        setVisitError('We could not load this patient\'s visit history.')
        return
      }
      setVisits((data ?? []) as Visit[])
    }

    void loadVisits()
    return () => {
      cancelled = true
    }
  }, [clinicId, patient.id, visitRefreshVersion])

  function handleVisitCreated(visit: Visit) {
    setShowVisitForm(false)
    setVisitSuccess(`Visit from ${formatDateTime(visit.visit_date)} was added to the patient history.`)
    setVisitRefreshVersion((version) => version + 1)
  }

  return (
    <section className="profile-page">
      <button className="back-button" onClick={onBack} type="button">Back to patients</button>
      {!editing ? <>
        <div className="profile-header"><div><p className="eyebrow">Patient file</p><h2>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</h2><p className="profile-number">File number <strong>{patient.patient_number}</strong></p></div><div className="profile-actions"><button className="button-secondary profile-secondary-action" onClick={() => setEditing(true)} type="button">Edit details</button><button className="button-secondary profile-secondary-action" onClick={() => { setAppointmentSuccess(null); setShowAppointmentForm(true) }} type="button">Book Appointment</button><button className="primary-action" disabled={role === 'receptionist' || role === 'patient'} onClick={() => { setVisitSuccess(null); setShowVisitForm(true) }} type="button">New Visit</button></div></div>
        <div className="profile-grid"><section className="profile-card"><p className="card-label">Personal details</p><dl className="detail-list"><DetailItem label="Full name" value={[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} /><DetailItem label="Gender" value={patient.gender} /><DetailItem label="Date of birth" value={formatDate(patient.date_of_birth)} /><DetailItem label="Age" value={formatPatientAge(patient)} /><DetailItem label="Registered" value={formatDate(patient.created_at)} /></dl></section><section className="profile-card"><p className="card-label">Contact details</p><dl className="detail-list"><DetailItem label="Phone" value={patient.phone} /><DetailItem label="Email" value={patient.email} /><DetailItem label="Address" value={patient.address} /></dl></section></div>
        {showAppointmentForm && <AppointmentForm clinicId={clinicId} userId={userId} patient={patient} onCancel={() => setShowAppointmentForm(false)} onCreated={(appointment) => { setShowAppointmentForm(false); setAppointmentSuccess(`Appointment booked for ${formatDate(appointment.appointment_date)} at ${formatTime(appointment.start_time)}.`) }} />}
        {appointmentSuccess && <div className="state-panel state-success" role="status">{appointmentSuccess}</div>}
        {role === 'receptionist' && <p className="role-note">A doctor or clinic administrator must be signed in to create a clinical visit.</p>}
        {showVisitForm && <NewVisitForm clinicId={clinicId} patientId={patient.id} doctorId={userId} clinicianLabel={clinicianLabel} onCancel={() => setShowVisitForm(false)} onCreated={handleVisitCreated} />}
        {visitSuccess && <div className="state-panel state-success" role="status">{visitSuccess}</div>}
        <section className="profile-card visit-history"><div className="section-heading"><div><p className="card-label">Visit history</p><h3>Clinical encounters</h3></div><span className="history-count">{visits.length} {visits.length === 1 ? 'visit' : 'visits'}</span></div>
          {visitLoading && <p className="inline-state" role="status">Loading visit history...</p>}
          {!visitLoading && visitError && <p className="form-error" role="alert">{visitError}</p>}
          {!visitLoading && !visitError && visits.length === 0 && <div className="empty-history"><h4>No visits recorded</h4><p>New clinical encounters will appear here without replacing previous records.</p></div>}
          {!visitLoading && !visitError && visits.length > 0 && <div className="visit-list">{visits.map((visit, index) => <VisitCard key={visit.id} visit={visit} isLatest={index === 0} clinicianLabel={visit.doctor_id === userId ? clinicianLabel : 'Clinic clinician'} />)}</div>}
        </section>
      </> : <PatientEditForm clinicId={clinicId} patient={patient} onCancel={() => setEditing(false)} onSaved={(updatedPatient) => { setEditing(false); onUpdated(updatedPatient) }} />}
    </section>
  )
}

type NewVisitFormValues = {
  visit_date: string
  chief_complaint: string
  assessment: string
  treatment_plan: string
  clinical_notes: string
}

const initialVisitForm: NewVisitFormValues = {
  visit_date: '',
  chief_complaint: '',
  assessment: '',
  treatment_plan: '',
  clinical_notes: '',
}

function NewVisitForm({ clinicId, patientId, doctorId, clinicianLabel, onCancel, onCreated }: { clinicId: string; patientId: string; doctorId: string; clinicianLabel: string; onCancel: () => void; onCreated: (visit: Visit) => void }) {
  const [form, setForm] = useState<NewVisitFormValues>(initialVisitForm)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updateField(field: keyof NewVisitFormValues, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form.chief_complaint.trim() && !form.clinical_notes.trim()) {
      setError('Enter a chief complaint or clinical note to create the visit.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }

    setSubmitting(true)
    setError(null)
    const { data: createdVisit, error: insertError } = await supabase.from('visits').insert({
      clinic_id: clinicId,
      patient_id: patientId,
      doctor_id: doctorId,
      ...(form.visit_date ? { visit_date: new Date(form.visit_date).toISOString() } : {}),
      chief_complaint: form.chief_complaint.trim() || null,
      assessment: form.assessment.trim() || null,
      treatment_plan: form.treatment_plan.trim() || null,
      clinical_notes: form.clinical_notes.trim() || null,
    } as never).select('*').single()
    setSubmitting(false)
    if (insertError) {
      setError('We could not create this visit. Confirm that your account has doctor or administrator access.')
      return
    }
    if (!createdVisit) {
      setError('The visit was saved, but it could not be loaded into the history.')
      return
    }
    onCreated(createdVisit as Visit)
  }

  return (
    <section className="registration-panel visit-form-panel" aria-labelledby="new-visit-heading">
      <div className="registration-heading"><p className="eyebrow">Clinical encounter</p><h2 id="new-visit-heading">New Visit</h2><p className="panel-copy">Record a new encounter as {clinicianLabel}. Previous visits remain unchanged.</p></div>
      <form className="patient-form" onSubmit={handleSubmit}>
        <label>Visit date and time<input type="datetime-local" value={form.visit_date} onChange={(event) => updateField('visit_date', event.target.value)} /></label>
        <label>Chief complaint<textarea value={form.chief_complaint} onChange={(event) => updateField('chief_complaint', event.target.value)} rows={3} /></label>
        <label>Assessment<textarea value={form.assessment} onChange={(event) => updateField('assessment', event.target.value)} rows={3} /></label>
        <label>Treatment plan<textarea value={form.treatment_plan} onChange={(event) => updateField('treatment_plan', event.target.value)} rows={3} /></label>
        <label className="full-width">Clinical notes<textarea value={form.clinical_notes} onChange={(event) => updateField('clinical_notes', event.target.value)} rows={4} /></label>
        <div className="form-actions"><button className="button-secondary" onClick={onCancel} type="button">Cancel</button><button type="submit" disabled={submitting}>{submitting ? 'Saving visit...' : 'Save visit'}</button></div>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  )
}

function VisitCard({ visit, isLatest, clinicianLabel }: { visit: Visit; isLatest: boolean; clinicianLabel: string }) {
  return <article className={`visit-card${isLatest ? ' latest' : ''}`}><div className="visit-card-header"><div><p className="visit-date">{formatDateTime(visit.visit_date)}</p><p className="visit-clinician">Recorded by {clinicianLabel}</p></div>{isLatest && <span className="latest-badge">Latest</span>}</div><div className="visit-fields">{visit.chief_complaint && <div><span>Chief complaint</span><p>{visit.chief_complaint}</p></div>}{visit.assessment && <div><span>Assessment</span><p>{visit.assessment}</p></div>}{visit.treatment_plan && <div><span>Treatment plan</span><p>{visit.treatment_plan}</p></div>}{visit.clinical_notes && <div><span>Clinical notes</span><p>{visit.clinical_notes}</p></div>}</div></article>
}

type AppointmentFormValues = {
  appointment_date: string
  start_time: string
  end_time: string
  doctor_id: string
  service: string
  notes: string
}

function todayInputValue() {
  return new Date().toISOString().slice(0, 10)
}

const initialAppointmentForm: AppointmentFormValues = {
  appointment_date: todayInputValue(),
  start_time: '',
  end_time: '',
  doctor_id: '',
  service: '',
  notes: '',
}

function AppointmentForm({ clinicId, userId, patient, onCancel, onCreated }: { clinicId: string; userId: string; patient: Patient; onCancel: () => void; onCreated: (appointment: Appointment) => void }) {
  const [form, setForm] = useState<AppointmentFormValues>(initialAppointmentForm)
  const [doctors, setDoctors] = useState<DoctorOption[]>([])
  const [loadingDoctors, setLoadingDoctors] = useState(true)
  const [doctorError, setDoctorError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadDoctors() {
      const result = await loadDoctorOptions(clinicId)
      if (cancelled) return
      setLoadingDoctors(false)
      setDoctors(result.doctors)
      setDoctorError(result.error)
    }
    void loadDoctors()
    return () => {
      cancelled = true
    }
  }, [clinicId])

  function updateField(field: keyof AppointmentFormValues, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form.appointment_date || !form.start_time || !form.end_time || !form.doctor_id) {
      setError('Appointment date, start time, end time, and doctor are required.')
      return
    }
    if (form.end_time <= form.start_time) {
      setError('End time must be after the start time.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }

    setSubmitting(true)
    setError(null)
    const { data: createdAppointment, error: insertError } = await supabase.from('appointments').insert({
      clinic_id: clinicId,
      patient_id: patient.id,
      doctor_id: form.doctor_id,
      created_by: userId,
      appointment_date: form.appointment_date,
      start_time: form.start_time,
      end_time: form.end_time,
      service: form.service.trim() || null,
      notes: form.notes.trim() || null,
      status: 'scheduled',
    } as never).select('*').single()
    setSubmitting(false)
    if (insertError) {
      setError('We could not book the appointment. Please confirm the selected doctor and clinic access.')
      return
    }
    if (!createdAppointment) {
      setError('The appointment was saved, but it could not be loaded.')
      return
    }
    onCreated(createdAppointment as Appointment)
  }

  return (
    <section className="registration-panel appointment-form-panel" aria-labelledby="book-appointment-heading">
      <div className="registration-heading"><p className="eyebrow">Appointment booking</p><h2 id="book-appointment-heading">Book Appointment</h2><p className="panel-copy">For {[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} · File {patient.patient_number}</p></div>
      {loadingDoctors && <p className="inline-state" role="status">Loading doctors...</p>}
      {!loadingDoctors && doctorError && <p className="form-error" role="alert">{doctorError}</p>}
      {!loadingDoctors && !doctorError && <form className="patient-form" onSubmit={handleSubmit}>
        <label>Patient<input value={[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} readOnly /></label>
        <label>Doctor<select value={form.doctor_id} onChange={(event) => updateField('doctor_id', event.target.value)} required><option value="">Select doctor</option>{doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}</select></label>
        <label>Appointment date<input type="date" min={todayInputValue()} value={form.appointment_date} onChange={(event) => updateField('appointment_date', event.target.value)} required /></label>
        <label>Status<select value="scheduled" disabled><option value="scheduled">Scheduled</option></select></label>
        <label>Start time<input type="time" value={form.start_time} onChange={(event) => updateField('start_time', event.target.value)} required /></label>
        <label>End time<input type="time" value={form.end_time} onChange={(event) => updateField('end_time', event.target.value)} required /></label>
        <label>Reason / service<input value={form.service} onChange={(event) => updateField('service', event.target.value)} /></label>
        <label className="full-width">Notes<textarea value={form.notes} onChange={(event) => updateField('notes', event.target.value)} rows={3} /></label>
        <div className="form-actions"><button className="button-secondary" onClick={onCancel} type="button">Cancel</button><button type="submit" disabled={submitting}>{submitting ? 'Booking appointment...' : 'Save appointment'}</button></div>
      </form>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  )
}

function DetailItem({ label, value }: { label: string; value: string | null | undefined }) {
  return <div><dt>{label}</dt><dd>{value || '-'}</dd></div>
}

function PatientEditForm({ clinicId, patient, onCancel, onSaved }: { clinicId: string; patient: Patient; onCancel: () => void; onSaved: (patient: Patient) => void }) {
  const [form, setForm] = useState<PatientFormValues>({
    first_name: patient.first_name,
    middle_name: patient.middle_name ?? '',
    last_name: patient.last_name,
    gender: patient.gender ?? '',
    date_of_birth: patient.date_of_birth ?? '',
    approximate_age_years: patient.approximate_age_years?.toString() ?? '',
    phone: patient.phone ?? '',
    email: patient.email ?? '',
    address: patient.address ?? '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updateField(field: keyof PatientFormValues, value: string) {
    setForm((current) => ({
      ...current,
      [field]: value,
      ...(field === 'date_of_birth' && value ? { approximate_age_years: '' } : {}),
      ...(field === 'approximate_age_years' && value ? { date_of_birth: '' } : {}),
    }))
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const firstName = form.first_name.trim()
    const lastName = form.last_name.trim()
    const email = form.email.trim()
    const ageInput = form.approximate_age_years.trim()
    const approximateAge = ageInput ? Number(ageInput) : null
    if (!firstName || !lastName || !form.gender) {
      setError('First name, last name, and gender are required.')
      return
    }
    if (email && !isValidEmail(email)) {
      setError('Enter a valid email address or leave email blank.')
      return
    }
    if (approximateAge !== null && (!Number.isInteger(approximateAge) || approximateAge < 0 || approximateAge > 130)) {
      setError('Approximate age must be a whole number between 0 and 130.')
      return
    }
    if (form.date_of_birth && ageInput) {
      setError('Enter either a date of birth or an approximate age, not both.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }

    setSubmitting(true)
    setError(null)
    const { data: updatedPatient, error: updateError } = await supabase.from('patients').update({
      first_name: firstName,
      middle_name: form.middle_name.trim() || null,
      last_name: lastName,
      gender: form.gender,
      date_of_birth: form.date_of_birth || null,
      approximate_age_years: approximateAge,
      phone: form.phone.trim() || null,
      email: email || null,
      address: form.address.trim() || null,
    } as never).eq('id', patient.id).eq('clinic_id', clinicId).select('*').single()
    setSubmitting(false)
    if (updateError) {
      setError('We could not update the patient details. Please try again.')
      return
    }
    if (!updatedPatient) {
      setError('The patient was updated, but the new details could not be loaded.')
      return
    }
    onSaved(updatedPatient as Patient)
  }

  return (
    <section className="registration-panel edit-panel" aria-labelledby="edit-patient-heading">
      <div className="registration-heading"><p className="eyebrow">Patient file {patient.patient_number}</p><h2 id="edit-patient-heading">Edit patient details</h2><p className="panel-copy">Update demographic and contact information only.</p></div>
      <form className="patient-form" onSubmit={handleSubmit}>
        <label>First name<input value={form.first_name} onChange={(event) => updateField('first_name', event.target.value)} autoComplete="given-name" required /></label>
        <label>Middle name<input value={form.middle_name} onChange={(event) => updateField('middle_name', event.target.value)} autoComplete="additional-name" /></label>
        <label>Last name<input value={form.last_name} onChange={(event) => updateField('last_name', event.target.value)} autoComplete="family-name" required /></label>
        <label>Gender<select value={form.gender} onChange={(event) => updateField('gender', event.target.value)} required><option value="">Select gender</option><option value="Male">Male</option><option value="Female">Female</option></select></label>
        <label>Date of birth<input type="date" value={form.date_of_birth} onChange={(event) => updateField('date_of_birth', event.target.value)} /></label>
        <label>Approximate age (years)<input type="number" min="0" max="130" step="1" value={form.approximate_age_years} onChange={(event) => updateField('approximate_age_years', event.target.value)} placeholder="Use if DOB is unknown" /></label>
        <label>Phone<input type="tel" value={form.phone} onChange={(event) => updateField('phone', event.target.value)} autoComplete="tel" /></label>
        <label>Email<input type="email" value={form.email} onChange={(event) => updateField('email', event.target.value)} autoComplete="email" /></label>
        <label className="full-width">Address<input value={form.address} onChange={(event) => updateField('address', event.target.value)} autoComplete="street-address" /></label>
        <div className="form-actions"><button className="button-secondary" onClick={onCancel} type="button">Cancel</button><button type="submit" disabled={submitting}>{submitting ? 'Saving changes...' : 'Save changes'}</button></div>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  )
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function formatPatientAge(patient: Patient) {
  if (patient.date_of_birth) {
    const birthDate = new Date(`${patient.date_of_birth}T00:00:00`)
    const today = new Date()
    let age = today.getFullYear() - birthDate.getFullYear()
    const birthdayPassed = today.getMonth() > birthDate.getMonth()
      || (today.getMonth() === birthDate.getMonth() && today.getDate() >= birthDate.getDate())
    if (!birthdayPassed) age -= 1
    return `${Math.max(age, 0)} years`
  }
  if (patient.approximate_age_years !== null && patient.approximate_age_years !== undefined) {
    return `Approx. ${patient.approximate_age_years} years`
  }
  return '-'
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value))
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatTime(value: string | null | undefined) {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(`1970-01-01T${value}`))
}

function formatStatus(value: string) {
  return value.replaceAll('_', ' ')
}

function StatusScreen({ message, action }: { message: string; action?: React.ReactNode }) {
  return <main className="auth-page"><section className="auth-panel"><p className="eyebrow">SmartDental HMIS</p><p className="panel-copy">{message}</p>{action}</section></main>
}

export default App
