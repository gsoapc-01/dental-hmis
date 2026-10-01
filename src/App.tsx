import { useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'

import './App.css'
import { getCurrentSession, signIn, signOut, subscribeToAuthChanges } from './lib/auth'
import { supabase } from './lib/supabase'
import type { Appointment, AppointmentStatus, Clinic, ClinicMembership, DentalChartEntry, DentalSurface, Investigation, Invoice, Patient, Payment, PaymentMethod, Prescription, UserRole, Visit } from './types/domain'

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
  const canViewFinance = context.membership.role === 'admin' || context.membership.role === 'receptionist'

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
          <button className={`nav-item nav-button${activeModule === 'Dashboard' ? ' active' : ''}`} onClick={() => setActiveModule('Dashboard')} type="button"><span className="nav-dot" />Dashboard</button>
          <span className="nav-item"><span className="nav-dot" />Clinical Visits</span>
          <button className={`nav-item nav-button${activeModule === 'Appointments' ? ' active' : ''}`} onClick={() => setActiveModule('Appointments')} type="button"><span className="nav-dot" />Appointments</button>
          <p className="nav-label nav-label-spaced">Management</p>
          {canViewFinance && <button className={`nav-item nav-button${activeModule === 'Billing' ? ' active' : ''}`} onClick={() => setActiveModule('Billing')} type="button"><span className="nav-dot" />Billing</button>}
          {canViewFinance && <button className={`nav-item nav-button${activeModule === 'Reports' ? ' active' : ''}`} onClick={() => setActiveModule('Reports')} type="button"><span className="nav-dot" />Reports</button>}
          {['Prescriptions', 'Investigations'].map((item) => <span className={`nav-item${activeModule === item ? ' active' : ''}`} key={item}><span className="nav-dot" />{item}</span>)}
          <button className={`nav-item nav-button${activeModule === 'Patients' ? ' active' : ''}`} onClick={() => setActiveModule('Patients')} type="button"><span className="nav-dot" />Patients</button>
        </nav>
        <div className="user-area"><div className="user-summary"><div className="avatar">{(context.user.email?.[0] ?? 'U').toUpperCase()}</div><div><p>{context.user.email ?? 'Signed-in user'}</p><p className="role">{context.membership.role}</p></div></div><button className="button-secondary" onClick={handleLogout}>Log out</button>{logoutError && <p className="form-error" role="alert">{logoutError}</p>}</div>
      </aside>
      <section className="shell-content">
        <header className="topbar"><div><p className="topbar-kicker">Clinic workspace</p><p className="topbar-title">{activeModule}</p></div><div className="topbar-meta"><span className="status-indicator" />Secure session</div></header>
        {activeModule === 'Appointments' ? <AppointmentsView clinicId={context.clinic.id} userId={context.user.id} role={context.membership.role} /> : activeModule === 'Patients' ? <PatientsView clinicId={context.clinic.id} clinicName={context.clinic.name} userId={context.user.id} role={context.membership.role} clinicianLabel={context.user.email ?? context.membership.role} /> : activeModule === 'Billing' && canViewFinance ? <BillingView clinicId={context.clinic.id} clinicName={context.clinic.name} currency={context.clinic.currency} /> : activeModule === 'Reports' && canViewFinance ? <ReportsView clinicId={context.clinic.id} timezone={context.clinic.timezone} /> : <DashboardView clinicId={context.clinic.id} clinicName={context.clinic.name} timezone={context.clinic.timezone} role={context.membership.role} userId={context.user.id} onOpenPatients={() => setActiveModule('Patients')} />}
      </section>
    </main>
  )
}

type DashboardAppointment = Pick<Appointment, 'id' | 'patient_id' | 'doctor_id' | 'appointment_date' | 'start_time' | 'end_time' | 'service' | 'status'>
type DashboardPatient = Pick<Patient, 'id' | 'patient_number' | 'first_name' | 'middle_name' | 'last_name'>
type DashboardPayment = Pick<Payment, 'id' | 'clinic_id' | 'invoice_id' | 'patient_id' | 'amount' | 'payment_method' | 'payment_date'>
type DashboardInvoice = Pick<Invoice, 'id' | 'patient_id' | 'invoice_number' | 'currency' | 'status' | 'balance'>
type InvoiceBalanceSummary = Pick<Invoice, 'id' | 'currency' | 'status' | 'balance'>
type ReportVisit = Pick<Visit, 'id' | 'doctor_id' | 'appointment_id'>

type DashboardData = {
  patientCount: number | null
  appointments: DashboardAppointment[]
  patients: Record<string, DashboardPatient>
  revenueByCurrency: Record<string, number>
  outstandingByCurrency: Record<string, number>
  recentPayments: DashboardPayment[]
  invoices: Record<string, DashboardInvoice>
}

function DashboardView({ clinicId, clinicName, timezone, role, userId, onOpenPatients }: { clinicId: string; clinicName: string; timezone: string; role: UserRole; userId: string; onOpenPatients: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const today = getClinicLocalDate(new Date(), timezone)
  const canViewFinance = role === 'admin' || role === 'receptionist'

  useEffect(() => {
    let cancelled = false

    async function loadDashboard() {
      if (!supabase) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }

      setLoading(true)
      setError(null)
      let appointmentQuery = supabase
        .from('appointments')
        .select('id, patient_id, doctor_id, appointment_date, start_time, end_time, service, status')
        .eq('clinic_id', clinicId)
        .eq('appointment_date', today)
        .order('start_time', { ascending: true })
      if (role === 'doctor') appointmentQuery = appointmentQuery.eq('doctor_id', userId)

      const [appointmentResult, patientCountResult] = await Promise.all([
        appointmentQuery,
        canViewFinance
          ? supabase.from('patients').select('id', { count: 'exact', head: true }).eq('clinic_id', clinicId)
          : Promise.resolve(null),
      ])
      if (cancelled) return
      if (appointmentResult.error || patientCountResult?.error) {
        setLoading(false)
        setError('We could not load the clinic dashboard.')
        return
      }

      const appointments = (appointmentResult.data ?? []) as DashboardAppointment[]
      const patientCount = patientCountResult?.count ?? null
      let todayPayments: DashboardPayment[] = []
      let recentPayments: DashboardPayment[] = []
      let openInvoices: DashboardInvoice[] = []
      let invoiceMap: Record<string, DashboardInvoice> = {}
      let revenueByCurrency: Record<string, number> = {}
      let outstandingByCurrency: Record<string, number> = {}

      if (canViewFinance) {
        const bounds = getClinicDateBounds(today, today, timezone)
        const [todayPaymentResult, recentPaymentResult, openInvoiceResult] = await Promise.all([
          supabase.from('payments').select('id, clinic_id, invoice_id, patient_id, amount, payment_method, payment_date').eq('clinic_id', clinicId).gte('payment_date', bounds.start).lt('payment_date', bounds.end).order('payment_date', { ascending: false }),
          supabase.from('payments').select('id, clinic_id, invoice_id, patient_id, amount, payment_method, payment_date').eq('clinic_id', clinicId).order('payment_date', { ascending: false }).limit(8),
          supabase.from('invoices').select('id, patient_id, invoice_number, currency, status, balance').eq('clinic_id', clinicId).in('status', ['draft', 'partially_paid']).gt('balance', 0),
        ])
        if (cancelled) return
        if (todayPaymentResult.error || recentPaymentResult.error || openInvoiceResult.error) {
          setLoading(false)
          setError('We could not load clinic billing summaries.')
          return
        }

        todayPayments = (todayPaymentResult.data ?? []) as DashboardPayment[]
        recentPayments = (recentPaymentResult.data ?? []) as DashboardPayment[]
        openInvoices = (openInvoiceResult.data ?? []) as DashboardInvoice[]
        const invoiceIds = [...new Set([...todayPayments, ...recentPayments].map((payment) => payment.invoice_id))]
        if (invoiceIds.length > 0) {
          const { data: paymentInvoiceRows, error: invoiceError } = await supabase.from('invoices').select('id, patient_id, invoice_number, currency, status, balance').eq('clinic_id', clinicId).in('id', invoiceIds)
          if (cancelled) return
          if (invoiceError) {
            setLoading(false)
            setError('We could not load invoice currencies for payment summaries.')
            return
          }
          invoiceMap = Object.fromEntries(((paymentInvoiceRows ?? []) as DashboardInvoice[]).map((invoice) => [invoice.id, invoice]))
        }
        openInvoices.forEach((invoice) => { invoiceMap[invoice.id] = invoice })
        revenueByCurrency = sumPaymentsByCurrency(todayPayments, invoiceMap)
        outstandingByCurrency = sumBalancesByCurrency(openInvoices)
      }

      const patientIds = [...new Set([
        ...appointments.map((appointment) => appointment.patient_id),
        ...recentPayments.map((payment) => payment.patient_id),
      ])]
      let patients: Record<string, DashboardPatient> = {}
      if (patientIds.length > 0) {
        const { data: patientRows, error: patientError } = await supabase.from('patients').select('id, patient_number, first_name, middle_name, last_name').eq('clinic_id', clinicId).in('id', patientIds)
        if (cancelled) return
        if (patientError) {
          setLoading(false)
          setError('We could not load patient names for the dashboard.')
          return
        }
        patients = Object.fromEntries(((patientRows ?? []) as DashboardPatient[]).map((patient) => [patient.id, patient]))
      }

      setData({ patientCount, appointments, patients, revenueByCurrency, outstandingByCurrency, recentPayments, invoices: invoiceMap })
      setLoading(false)
    }

    void loadDashboard()
    return () => { cancelled = true }
  }, [canViewFinance, clinicId, role, today, timezone, userId])

  const appointments = data?.appointments ?? []
  const waitingAppointments = appointments.filter((appointment) => appointment.status === 'waiting')
  const inProgressAppointments = appointments.filter((appointment) => appointment.status === 'in_progress')
  const completedAppointments = appointments.filter((appointment) => appointment.status === 'completed')
  const currencyTotals = (totals: Record<string, number>) => Object.entries(totals).sort(([first], [second]) => first.localeCompare(second)).map(([currency, amount]) => <span key={currency}>{formatMoney(amount, currency)}</span>)
  const patientName = (patientId: string) => {
    const patient = data?.patients[patientId]
    return patient ? `${[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} · ${patient.patient_number}` : 'Patient details unavailable'
  }

  return (
    <div className="dashboard-page">
      <div className="dashboard-intro"><div><p className="eyebrow">Clinic operations · {today}</p><h1>{clinicName}</h1><p className="panel-copy">Today’s schedule and workload.</p></div><button className="primary-action" onClick={onOpenPatients} type="button">Open patient list</button></div>
      {error && <div className="state-panel state-error" role="alert">{error}</div>}
      {loading && <p className="inline-state" role="status">Loading dashboard...</p>}
      {!loading && !error && data && <>
        <div className="summary-grid dashboard-metrics">
          {canViewFinance ? <>
            <DashboardMetric label="Total Patients" value={String(data.patientCount ?? 0)} />
            <DashboardMetric label="Today's Appointments" value={String(appointments.length)} />
            <DashboardMetric label="Waiting Patients" value={String(new Set(waitingAppointments.map((appointment) => appointment.patient_id)).size)} />
            <DashboardMetric label="Consultations In Progress" value={String(inProgressAppointments.length)} />
            <DashboardMetric label="Completed Today" value={String(completedAppointments.length)} />
            <DashboardMetric label="Today's Payments" value={currencyTotals(data.revenueByCurrency)} />
            <DashboardMetric label="Current Outstanding Balance" value={currencyTotals(data.outstandingByCurrency)} />
          </> : <>
            <DashboardMetric label="My Appointments Today" value={String(appointments.length)} />
            <DashboardMetric label="My Waiting Patients" value={String(new Set(waitingAppointments.map((appointment) => appointment.patient_id)).size)} />
            <DashboardMetric label="My Consultations In Progress" value={String(inProgressAppointments.length)} />
            <DashboardMetric label="My Completed Appointments Today" value={String(completedAppointments.length)} />
          </>}
        </div>
        <div className="dashboard-sections">
          <DashboardSection title="Today's Schedule">
            {appointments.length === 0 ? <p className="inline-state">No appointments scheduled today.</p> : <div className="dashboard-row-list">{appointments.map((appointment) => <div className="dashboard-row" key={appointment.id}><span>{formatTime(appointment.start_time)}</span><strong>{patientName(appointment.patient_id)}</strong><span className={`appointment-status status-${appointment.status}`}>{formatStatus(appointment.status)}</span>{appointment.service && <small>{appointment.service}</small>}</div>)}</div>}
          </DashboardSection>
          <DashboardSection title="Waiting Queue">
            {waitingAppointments.length === 0 ? <p className="inline-state">No patients waiting.</p> : <div className="dashboard-row-list">{waitingAppointments.map((appointment) => <div className="dashboard-row" key={appointment.id}><span>{formatTime(appointment.start_time)}</span><strong>{patientName(appointment.patient_id)}</strong>{appointment.service && <small>{appointment.service}</small>}</div>)}</div>}
          </DashboardSection>
          {canViewFinance && <DashboardSection title="Recent Payments">
            {data.recentPayments.length === 0 ? <p className="inline-state">No payments recorded yet.</p> : <div className="dashboard-row-list">{data.recentPayments.map((payment) => {
              const invoice = data.invoices[payment.invoice_id]
              return <div className="dashboard-row" key={payment.id}><span>{formatDateTimeInTimezone(payment.payment_date, timezone)}</span><strong>{patientName(payment.patient_id)}</strong><span>{invoice ? formatMoney(payment.amount, invoice.currency) : 'Currency unavailable'}</span><small>{invoice?.invoice_number ?? ''} · {formatStatus(payment.payment_method)}</small></div>
            })}</div>}
          </DashboardSection>}
        </div>
      </>}
    </div>
  )
}

function DashboardMetric({ label, value }: { label: string; value: React.ReactNode }) {
  return <section className="summary-card"><p className="card-label">{label}</p><p className="card-value">{value}</p></section>
}

function DashboardSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="dashboard-list-section"><div className="section-heading"><h3>{title}</h3></div>{children}</section>
}

type ReportsData = {
  registrations: number
  appointments: DashboardAppointment[]
  visits: ReportVisit[]
  paymentsByCurrency: Record<string, number>
  paymentsByMethod: Record<string, Record<string, number>>
  outstandingByCurrency: Record<string, number>
  doctorActivity: Array<{ id: string; label: string; appointments: number; visits: number }>
}

function ReportsView({ clinicId, timezone }: { clinicId: string; timezone: string }) {
  const today = getClinicLocalDate(new Date(), timezone)
  const [startDate, setStartDate] = useState(`${today.slice(0, 7)}-01`)
  const [endDate, setEndDate] = useState(today)
  const [data, setData] = useState<ReportsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const effectiveStart = startDate || `${(endDate || today).slice(0, 7)}-01`
  const effectiveEnd = endDate || today

  useEffect(() => {
    let cancelled = false

    async function loadReports() {
      if (effectiveStart > effectiveEnd) {
        setLoading(false)
        setError('The start date must be on or before the end date.')
        return
      }
      if (!supabase) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }

      setLoading(true)
      setError(null)
      const bounds = getClinicDateBounds(effectiveStart, effectiveEnd, timezone)
      const [registrationResult, appointmentResult, visitResult, paymentResult, invoiceResult, doctorResult] = await Promise.all([
        supabase.from('patients').select('id', { count: 'exact', head: true }).eq('clinic_id', clinicId).gte('created_at', bounds.start).lt('created_at', bounds.end),
        supabase.from('appointments').select('id, patient_id, doctor_id, appointment_date, start_time, end_time, service, status').eq('clinic_id', clinicId).gte('appointment_date', effectiveStart).lte('appointment_date', effectiveEnd).order('appointment_date', { ascending: true }).order('start_time', { ascending: true }),
        supabase.from('visits').select('id, doctor_id, appointment_id').eq('clinic_id', clinicId).gte('visit_date', bounds.start).lt('visit_date', bounds.end),
        supabase.from('payments').select('id, clinic_id, invoice_id, patient_id, amount, payment_method, payment_date').eq('clinic_id', clinicId).gte('payment_date', bounds.start).lt('payment_date', bounds.end),
        supabase.from('invoices').select('id, currency, status, balance').eq('clinic_id', clinicId).in('status', ['draft', 'partially_paid']).gt('balance', 0),
        loadDoctorOptions(clinicId),
      ])
      if (cancelled) return
      if (registrationResult.error || appointmentResult.error || visitResult.error || paymentResult.error || invoiceResult.error) {
        setLoading(false)
        setError('We could not load reports for this date range.')
        return
      }

      const appointments = (appointmentResult.data ?? []) as DashboardAppointment[]
      const visits = (visitResult.data ?? []) as ReportVisit[]
      const payments = (paymentResult.data ?? []) as DashboardPayment[]
      const openInvoices = (invoiceResult.data ?? []) as InvoiceBalanceSummary[]
      const paymentInvoiceIds = [...new Set(payments.map((payment) => payment.invoice_id))]
      let paymentInvoiceRows: InvoiceBalanceSummary[] = []
      if (paymentInvoiceIds.length > 0) {
        const { data: paymentInvoiceData, error: paymentInvoiceError } = await supabase.from('invoices').select('id, currency, status, balance').eq('clinic_id', clinicId).in('id', paymentInvoiceIds)
        if (cancelled) return
        if (paymentInvoiceError) {
          setLoading(false)
          setError('We could not load invoice currencies for payment reports.')
          return
        }
        paymentInvoiceRows = (paymentInvoiceData ?? []) as InvoiceBalanceSummary[]
      }
      const invoiceMap = Object.fromEntries([...openInvoices, ...paymentInvoiceRows].map((invoice) => [invoice.id, invoice]))
      const doctorLabels = Object.fromEntries(doctorResult.doctors.map((doctor) => [doctor.id, doctor.name]))
      const doctorIds = [...new Set([...appointments.map((appointment) => appointment.doctor_id), ...visits.map((visit) => visit.doctor_id)].filter((id): id is string => Boolean(id)))]
      const doctorActivity = doctorIds.map((id) => ({
        id,
        label: doctorLabels[id] ?? 'Clinic doctor',
        appointments: appointments.filter((appointment) => appointment.doctor_id === id).length,
        visits: visits.filter((visit) => visit.doctor_id === id).length,
      })).sort((first, second) => second.visits + second.appointments - first.visits - first.appointments)
      const paymentsByMethod: Record<string, Record<string, number>> = {}
      for (const payment of payments) {
        const currency = invoiceMap[payment.invoice_id]?.currency
        if (!currency) continue
        paymentsByMethod[payment.payment_method] ??= {}
        paymentsByMethod[payment.payment_method][currency] = (paymentsByMethod[payment.payment_method][currency] ?? 0) + payment.amount
      }

      setData({
        registrations: registrationResult.count ?? 0,
        appointments,
        visits,
        paymentsByCurrency: sumPaymentsByCurrency(payments, invoiceMap),
        paymentsByMethod,
        outstandingByCurrency: sumBalancesByCurrency(openInvoices),
        doctorActivity,
      })
      setLoading(false)
    }

    void loadReports()
    return () => { cancelled = true }
  }, [clinicId, effectiveEnd, effectiveStart, timezone])

  const appointmentsByStatus = (data?.appointments ?? []).reduce<Record<string, number>>((counts, appointment) => {
    counts[appointment.status] = (counts[appointment.status] ?? 0) + 1
    return counts
  }, {})
  const totals = (values: Record<string, number>) => Object.entries(values).sort(([first], [second]) => first.localeCompare(second)).map(([currency, amount]) => <span key={currency}>{formatMoney(amount, currency)}</span>)

  return <div className="reports-page">
    <div className="page-heading"><div><p className="eyebrow">Clinic operations</p><h1>Reports</h1><p className="panel-copy">Period activity and current balances.</p></div></div>
    <div className="report-date-range"><label>From<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label>Through<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div>
    {error && <div className="state-panel state-error" role="alert">{error}</div>}
    {loading && <p className="inline-state" role="status">Loading reports...</p>}
    {!loading && !error && data && <>
      <div className="summary-grid report-metrics">
        <DashboardMetric label="Patient Registrations" value={String(data.registrations)} />
        <DashboardMetric label="Appointments" value={String(data.appointments.length)} />
        <DashboardMetric label="Visits / Consultations" value={String(data.visits.length)} />
        <DashboardMetric label="Payments Received" value={totals(data.paymentsByCurrency)} />
      </div>
      <div className="report-grid">
        <DashboardSection title="Appointment Status">
          {Object.keys(appointmentsByStatus).length === 0 ? <p className="inline-state">No appointments in this period.</p> : <div className="report-value-list">{Object.entries(appointmentsByStatus).map(([status, count]) => <div key={status}><span>{formatStatus(status)}</span><strong>{count}</strong></div>)}</div>}
        </DashboardSection>
        <DashboardSection title="Payments by Method and Currency">
          {Object.keys(data.paymentsByMethod).length === 0 ? <p className="inline-state">No payments in this period.</p> : <div className="report-value-list">{Object.entries(data.paymentsByMethod).sort(([first], [second]) => first.localeCompare(second)).map(([method, currencies]) => <div key={method}><span>{formatStatus(method)}</span><strong>{totals(currencies)}</strong></div>)}</div>}
        </DashboardSection>
        <DashboardSection title="Current Outstanding Balance">
          <p className="report-caption">Current snapshot, not a historical balance for the selected dates.</p>
          {Object.keys(data.outstandingByCurrency).length === 0 ? <p className="inline-state">No outstanding balances.</p> : <div className="report-value-list">{Object.entries(data.outstandingByCurrency).sort(([first], [second]) => first.localeCompare(second)).map(([currency, amount]) => <div key={currency}><span>{currency}</span><strong>{formatMoney(amount, currency)}</strong></div>)}</div>}
        </DashboardSection>
        <DashboardSection title="Doctor Activity">
          {data.doctorActivity.length === 0 ? <p className="inline-state">No doctor activity in this period.</p> : <div className="report-value-list">{data.doctorActivity.map((doctor) => <div key={doctor.id}><span>{doctor.label}</span><strong>{doctor.appointments} appointments · {doctor.visits} visits</strong></div>)}</div>}
        </DashboardSection>
      </div>
    </>}
  </div>
}

function sumPaymentsByCurrency(payments: DashboardPayment[], invoices: Record<string, Pick<Invoice, 'currency'>>) {
  return payments.reduce<Record<string, number>>((totals, payment) => {
    const currency = invoices[payment.invoice_id]?.currency
    if (currency) totals[currency] = (totals[currency] ?? 0) + payment.amount
    return totals
  }, {})
}

function sumBalancesByCurrency(invoices: Array<Pick<Invoice, 'currency' | 'balance'>>) {
  return invoices.reduce<Record<string, number>>((totals, invoice) => {
    if (invoice.balance > 0) totals[invoice.currency] = (totals[invoice.currency] ?? 0) + invoice.balance
    return totals
  }, {})
}

function getClinicLocalDate(now: Date, timezone: string | null | undefined) {
  const safeTimezone = getSafeTimezone(timezone)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: safeTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function getSafeTimezone(timezone: string | null | undefined) {
  const candidate = timezone?.trim() || 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format()
    return candidate
  } catch {
    return 'UTC'
  }
}

function formatDateTimeInTimezone(value: string, timezone: string | null | undefined) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: getSafeTimezone(timezone) }).format(new Date(value))
}

function addCalendarDay(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1))
  return `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDate.getUTCDate()).padStart(2, '0')}`
}

function localMidnightToUtc(date: string, timezone: string | null | undefined) {
  const [year, month, day] = date.split('-').map(Number)
  const desiredTime = Date.UTC(year, month - 1, day)
  let candidateTime = desiredTime
  const safeTimezone = getSafeTimezone(timezone)
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: safeTimezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(candidateTime))
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    const representedTime = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second))
    const adjustment = desiredTime - representedTime
    candidateTime += adjustment
    if (adjustment === 0) break
  }

  return new Date(candidateTime).toISOString()
}

function getClinicDateBounds(startDate: string, inclusiveEndDate: string, timezone: string | null | undefined) {
  return {
    start: localMidnightToUtc(startDate, timezone),
    end: localMidnightToUtc(addCalendarDay(inclusiveEndDate), timezone),
  }
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
  const [activeConsultation, setActiveConsultation] = useState<{ appointment: Appointment; patient: PatientAppointmentSummary; visit: Visit } | null>(null)

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

  async function startConsultation(appointment: Appointment) {
    if (role === 'receptionist' || appointment.status !== 'waiting' || (role === 'doctor' && appointment.doctor_id !== userId)) return
    if (!supabase) {
      setTransitionError('Supabase is not configured.')
      return
    }

    setTransitioningId(appointment.id)
    setTransitionError(null)
    const { data, error: startError } = await supabase.rpc('start_consultation', { p_appointment_id: appointment.id } as never)
    setTransitioningId(null)
    if (startError || !data) {
      setTransitionError('We could not start this consultation. Refresh the queue and try again.')
      return
    }
    const patient = patients[appointment.patient_id]
    if (!patient) {
      setTransitionError('The consultation started, but the patient details could not be loaded.')
      return
    }
    setActiveConsultation({ appointment: { ...appointment, status: 'in_progress' }, patient, visit: data as Visit })
    setRefreshVersion((version) => version + 1)
  }

  function finishConsultation() {
    setActiveConsultation(null)
    setRefreshVersion((version) => version + 1)
  }

  return (
    <div className="appointments-page">
      <div className="page-heading"><div><p className="eyebrow">Care coordination</p><h1>Appointments</h1><p className="panel-copy">Schedule and manage today\'s patient arrivals.</p></div><button className="button-secondary refresh-button" onClick={() => setRefreshVersion((version) => version + 1)} type="button">Refresh</button></div>
      <div className="appointment-tabs" role="tablist" aria-label="Appointment views"><button className={activeView === 'upcoming' ? 'active' : ''} onClick={() => setActiveView('upcoming')} role="tab" type="button">Upcoming <span>{appointments.length}</span></button><button className={activeView === 'today' ? 'active' : ''} onClick={() => setActiveView('today')} role="tab" type="button">Today <span>{todayAppointments.length}</span></button><button className={activeView === 'waiting' ? 'active' : ''} onClick={() => setActiveView('waiting')} role="tab" type="button">Waiting queue <span>{visibleWaitingAppointments.length}</span></button></div>
      {loading && <div className="state-panel" role="status">Loading upcoming appointments...</div>}
      {!loading && error && <div className="state-panel state-error" role="alert">{error}</div>}
      {!loading && !error && transitionError && <div className="state-panel state-error" role="alert">{transitionError}</div>}
      {activeConsultation && <><ConsultationPanel appointment={activeConsultation.appointment} patient={activeConsultation.patient} visit={activeConsultation.visit} clinicianLabel={role === 'admin' ? 'clinic administrator' : 'assigned doctor'} onCompleted={finishConsultation} onCancel={() => setActiveConsultation(null)} /><DentalChart clinicId={clinicId} visit={activeConsultation.visit} userId={userId} canCreate defaultOpen /></>}
      {!loading && !error && !hasAppointments && <div className="state-panel"><h2>No upcoming appointments</h2><p>Appointments booked from patient files will appear here.</p></div>}
      {!loading && !error && hasAppointments && displayedAppointments.length === 0 && <div className="state-panel"><h2>{activeView === 'waiting' ? 'No patients waiting' : activeView === 'today' ? 'No appointments today' : 'No upcoming appointments'}</h2><p>{activeView === 'waiting' ? 'Patients sent to waiting will appear here.' : 'Appointments booked from patient files will appear here.'}</p></div>}
      {!activeConsultation && !loading && !error && displayedAppointments.length > 0 && <div className="appointment-list">{displayedAppointments.map((appointment) => <AppointmentCard key={appointment.id} appointment={appointment} patient={patients[appointment.patient_id]} doctorName={doctors[appointment.doctor_id ?? '']} role={role} userId={userId} onTransition={transitionAppointment} onStartConsultation={startConsultation} transitioning={transitioningId === appointment.id} />)}</div>}
    </div>
  )
}

function AppointmentCard({ appointment, patient, doctorName, role, userId, onTransition, onStartConsultation, transitioning }: { appointment: Appointment; patient?: PatientAppointmentSummary; doctorName?: string; role: UserRole; userId: string; onTransition: (appointment: Appointment, nextStatus: 'arrived' | 'waiting') => void; onStartConsultation: (appointment: Appointment) => void; transitioning: boolean }) {
  const canCheckIn = appointment.status === 'scheduled' || appointment.status === 'confirmed'
  const canSendToWaiting = appointment.status === 'arrived'
  const canStartConsultation = role !== 'receptionist' && appointment.status === 'waiting' && (role === 'admin' || appointment.doctor_id === userId)

  return <article className="appointment-card"><div className="appointment-date-block"><span>{formatDate(appointment.appointment_date)}</span><strong>{formatTime(appointment.start_time)}</strong><small>{formatTime(appointment.end_time)}</small></div><div className="appointment-main"><p className="appointment-patient">{patient ? [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ') : 'Patient unavailable'}</p><p className="appointment-file">File {patient?.patient_number ?? '-'}</p>{appointment.service && <p className="appointment-reason">{appointment.service}</p>}</div><div className="appointment-meta"><p>{doctorName ?? 'Doctor unavailable'}</p><span className={`appointment-status status-${appointment.status}`}>{formatStatus(appointment.status)}</span><div className="appointment-actions">{canCheckIn && <button onClick={() => onTransition(appointment, 'arrived')} disabled={transitioning} type="button">{transitioning ? 'Updating...' : 'Check In'}</button>}{canSendToWaiting && <button onClick={() => onTransition(appointment, 'waiting')} disabled={transitioning} type="button">{transitioning ? 'Updating...' : 'Send to Waiting'}</button>}{canStartConsultation && <button onClick={() => onStartConsultation(appointment)} disabled={transitioning || !patient} type="button">{transitioning ? 'Starting...' : 'Start Consultation'}</button>}</div></div></article>
}

type ConsultationFormValues = {
  chief_complaint: string
  hpi: string
  examination: string
  assessment: string
  treatment_plan: string
  clinical_notes: string
  follow_up_date: string
  follow_up_instructions: string
}

function consultationFormFromVisit(visit: Visit): ConsultationFormValues {
  return {
    chief_complaint: visit.chief_complaint ?? '',
    hpi: visit.hpi ?? '',
    examination: visit.examination ?? '',
    assessment: visit.assessment ?? '',
    treatment_plan: visit.treatment_plan ?? '',
    clinical_notes: visit.clinical_notes ?? '',
    follow_up_date: visit.follow_up_date ?? '',
    follow_up_instructions: visit.follow_up_instructions ?? '',
  }
}

function ConsultationPanel({ appointment, patient, visit, clinicianLabel, onCompleted, onCancel }: { appointment: Appointment; patient: PatientAppointmentSummary; visit: Visit; clinicianLabel: string; onCompleted: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<ConsultationFormValues>(() => consultationFormFromVisit(visit))
  const [saving, setSaving] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function updateField(field: keyof ConsultationFormValues, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
    setMessage(null)
  }

  function rpcPayload() {
    return {
      p_visit_id: visit.id,
      p_chief_complaint: form.chief_complaint.trim() || null,
      p_hpi: form.hpi.trim() || null,
      p_examination: form.examination.trim() || null,
      p_assessment: form.assessment.trim() || null,
      p_treatment_plan: form.treatment_plan.trim() || null,
      p_clinical_notes: form.clinical_notes.trim() || null,
      p_follow_up_date: form.follow_up_date || null,
      p_follow_up_instructions: form.follow_up_instructions.trim() || null,
    }
  }

  async function saveDraft() {
    if (!supabase) {
      setError('Supabase is not configured.')
      return false
    }
    setSaving(true)
    setError(null)
    setMessage(null)
    const { error: saveError } = await supabase.rpc('save_consultation', rpcPayload() as never)
    setSaving(false)
    if (saveError) {
      setError('We could not save this consultation. Refresh and try again.')
      return false
    }
    setMessage('Draft saved.')
    return true
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await saveDraft()
  }

  async function completeConsultation() {
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }
    setCompleting(true)
    setError(null)
    setMessage(null)
    const { error: completeError } = await supabase.rpc('complete_consultation', rpcPayload() as never)
    setCompleting(false)
    if (completeError) {
      setError('We could not complete this consultation. Refresh and try again.')
      return
    }
    setMessage('Consultation completed and added to visit history.')
    onCompleted()
  }

  return <section className="registration-panel consultation-panel" aria-labelledby="consultation-heading"><div className="registration-heading"><p className="eyebrow">Active consultation</p><h2 id="consultation-heading">{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</h2><p className="panel-copy">File {patient.patient_number} · {appointment.service || 'Appointment consultation'} · Working as {clinicianLabel}</p></div><form className="patient-form" onSubmit={handleSubmit}><label>Chief complaint<textarea value={form.chief_complaint} onChange={(event) => updateField('chief_complaint', event.target.value)} rows={3} /></label><label>History of present illness<textarea value={form.hpi} onChange={(event) => updateField('hpi', event.target.value)} rows={3} /></label><label>Examination<textarea value={form.examination} onChange={(event) => updateField('examination', event.target.value)} rows={3} /></label><label>Assessment / diagnosis<textarea value={form.assessment} onChange={(event) => updateField('assessment', event.target.value)} rows={3} /></label><label>Treatment plan<textarea value={form.treatment_plan} onChange={(event) => updateField('treatment_plan', event.target.value)} rows={3} /></label><label>Follow-up date<input type="date" value={form.follow_up_date} onChange={(event) => updateField('follow_up_date', event.target.value)} /></label><label className="full-width">Follow-up instructions<textarea value={form.follow_up_instructions} onChange={(event) => updateField('follow_up_instructions', event.target.value)} rows={3} /></label><label className="full-width">Clinical notes<textarea value={form.clinical_notes} onChange={(event) => updateField('clinical_notes', event.target.value)} rows={4} /></label><div className="form-actions"><button className="button-secondary" onClick={onCancel} type="button">Leave consultation</button><button className="button-secondary" disabled={saving || completing} onClick={() => { void saveDraft() }} type="button">{saving ? 'Saving...' : 'Save draft'}</button><button type="button" disabled={saving || completing} onClick={() => { void completeConsultation() }}>{completing ? 'Completing...' : 'Complete Consultation'}</button></div></form><VisitClinicalRecordsPanel clinicId={visit.clinic_id} patientId={visit.patient_id} visitId={visit.id} doctorId={visit.doctor_id} disabled={saving || completing} />{message && <p className="inline-state" role="status">{message}</p>}{error && <p className="form-error" role="alert">{error}</p>}</section>
}

type PrescriptionFormValues = {
  medicine: string
  strength: string
  dose: string
  route: string
  frequency: string
  duration: string
  quantity: string
  instructions: string
}

type InvestigationFormValues = {
  investigation_type: string
  status: string
  notes: string
}

const initialPrescriptionForm: PrescriptionFormValues = { medicine: '', strength: '', dose: '', route: '', frequency: '', duration: '', quantity: '', instructions: '' }
const initialInvestigationForm: InvestigationFormValues = { investigation_type: '', status: '', notes: '' }

function VisitClinicalRecordsPanel({ clinicId, patientId, visitId, doctorId, disabled }: { clinicId: string; patientId: string; visitId: string; doctorId: string; disabled: boolean }) {
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([])
  const [investigations, setInvestigations] = useState<Investigation[]>([])
  const [prescriptionForm, setPrescriptionForm] = useState<PrescriptionFormValues>(initialPrescriptionForm)
  const [investigationForm, setInvestigationForm] = useState<InvestigationFormValues>(initialInvestigationForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadRecords() {
      if (!supabase) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }
      const [prescriptionResult, investigationResult] = await Promise.all([
        supabase.from('prescriptions').select('*').eq('clinic_id', clinicId).eq('visit_id', visitId).order('created_at', { ascending: true }),
        supabase.from('investigations').select('*').eq('clinic_id', clinicId).eq('visit_id', visitId).order('created_at', { ascending: true }),
      ])
      if (cancelled) return
      setLoading(false)
      if (prescriptionResult.error || investigationResult.error) {
        setError('We could not load this visit\'s prescriptions and investigations.')
        return
      }
      setPrescriptions((prescriptionResult.data ?? []) as Prescription[])
      setInvestigations((investigationResult.data ?? []) as Investigation[])
    }
    void loadRecords()
    return () => { cancelled = true }
  }, [clinicId, visitId])

  async function addPrescription(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!prescriptionForm.medicine.trim() || !supabase) {
      setError(!supabase ? 'Supabase is not configured.' : 'Medicine is required.')
      return
    }
    setSaving(true)
    setError(null)
    const { data, error: insertError } = await supabase.from('prescriptions').insert({
      clinic_id: clinicId,
      patient_id: patientId,
      visit_id: visitId,
      prescribing_doctor_id: doctorId,
      medicine: prescriptionForm.medicine.trim(),
      strength: prescriptionForm.strength.trim() || null,
      dose: prescriptionForm.dose.trim() || null,
      route: prescriptionForm.route.trim() || null,
      frequency: prescriptionForm.frequency.trim() || null,
      duration: prescriptionForm.duration.trim() || null,
      quantity: prescriptionForm.quantity.trim() ? Number(prescriptionForm.quantity) : null,
      instructions: prescriptionForm.instructions.trim() || null,
    } as never).select('*').single()
    setSaving(false)
    if (insertError || !data) {
      setError('We could not add this prescription. Confirm that the consultation is still active.')
      return
    }
    setPrescriptions((current) => [...current, data as Prescription])
    setPrescriptionForm(initialPrescriptionForm)
  }

  async function addInvestigation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!investigationForm.investigation_type.trim() || !supabase) {
      setError(!supabase ? 'Supabase is not configured.' : 'Investigation type is required.')
      return
    }
    setSaving(true)
    setError(null)
    const { data, error: insertError } = await supabase.from('investigations').insert({
      clinic_id: clinicId,
      patient_id: patientId,
      visit_id: visitId,
      requesting_doctor_id: doctorId,
      investigation_type: investigationForm.investigation_type.trim(),
      status: investigationForm.status.trim() || null,
      notes: investigationForm.notes.trim() || null,
    } as never).select('*').single()
    setSaving(false)
    if (insertError || !data) {
      setError('We could not add this investigation. Confirm that the consultation is still active.')
      return
    }
    setInvestigations((current) => [...current, data as Investigation])
    setInvestigationForm(initialInvestigationForm)
  }

  return <section className="clinical-records-panel"><div className="section-heading"><div><p className="card-label">Visit records</p><h3>Prescriptions and investigations</h3></div><span className="history-count">{prescriptions.length + investigations.length} records</span></div>{loading && <p className="inline-state" role="status">Loading visit records...</p>}{!loading && <div className="clinical-records-grid"><section><h4>Prescriptions</h4>{prescriptions.length === 0 ? <p className="inline-state">No prescriptions recorded.</p> : <div className="clinical-record-list">{prescriptions.map((prescription) => <article className="clinical-record" key={prescription.id}><strong>{prescription.medicine}</strong><span>{[prescription.strength, prescription.dose, prescription.route, prescription.frequency, prescription.duration].filter(Boolean).join(' · ') || 'Details not specified'}</span>{prescription.instructions && <p>{prescription.instructions}</p>}</article>)}</div>}<form className="record-form" onSubmit={addPrescription}><input placeholder="Medicine" value={prescriptionForm.medicine} onChange={(event) => setPrescriptionForm((current) => ({ ...current, medicine: event.target.value }))} disabled={disabled} required /><input placeholder="Strength" value={prescriptionForm.strength} onChange={(event) => setPrescriptionForm((current) => ({ ...current, strength: event.target.value }))} disabled={disabled} /><input placeholder="Dose" value={prescriptionForm.dose} onChange={(event) => setPrescriptionForm((current) => ({ ...current, dose: event.target.value }))} disabled={disabled} /><input placeholder="Route" value={prescriptionForm.route} onChange={(event) => setPrescriptionForm((current) => ({ ...current, route: event.target.value }))} disabled={disabled} /><input placeholder="Frequency" value={prescriptionForm.frequency} onChange={(event) => setPrescriptionForm((current) => ({ ...current, frequency: event.target.value }))} disabled={disabled} /><input placeholder="Duration" value={prescriptionForm.duration} onChange={(event) => setPrescriptionForm((current) => ({ ...current, duration: event.target.value }))} disabled={disabled} /><input type="number" min="0" step="any" placeholder="Quantity" value={prescriptionForm.quantity} onChange={(event) => setPrescriptionForm((current) => ({ ...current, quantity: event.target.value }))} disabled={disabled} /><input placeholder="Instructions" value={prescriptionForm.instructions} onChange={(event) => setPrescriptionForm((current) => ({ ...current, instructions: event.target.value }))} disabled={disabled} /><button type="submit" disabled={disabled || saving}>{saving ? 'Adding...' : 'Add prescription'}</button></form></section><section><h4>Investigations</h4>{investigations.length === 0 ? <p className="inline-state">No investigations requested.</p> : <div className="clinical-record-list">{investigations.map((investigation) => <article className="clinical-record" key={investigation.id}><strong>{investigation.investigation_type}</strong><span>{investigation.status || 'Requested'}</span>{investigation.notes && <p>{investigation.notes}</p>}</article>)}</div>}<form className="record-form" onSubmit={addInvestigation}><input placeholder="Investigation type" value={investigationForm.investigation_type} onChange={(event) => setInvestigationForm((current) => ({ ...current, investigation_type: event.target.value }))} disabled={disabled} required /><input placeholder="Status" value={investigationForm.status} onChange={(event) => setInvestigationForm((current) => ({ ...current, status: event.target.value }))} disabled={disabled} /><textarea placeholder="Notes" value={investigationForm.notes} onChange={(event) => setInvestigationForm((current) => ({ ...current, notes: event.target.value }))} disabled={disabled} rows={2} /><button type="submit" disabled={disabled || saving}>{saving ? 'Adding...' : 'Add investigation'}</button></form></section></div>}{error && <p className="form-error" role="alert">{error}</p>}</section>
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

function PatientsView({ clinicId, clinicName, userId, role, clinicianLabel }: { clinicId: string; clinicName: string; userId: string; role: UserRole; clinicianLabel: string }) {
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
      {selectedPatient && <PatientProfile clinicId={clinicId} clinicName={clinicName} userId={userId} role={role} clinicianLabel={clinicianLabel} patient={selectedPatient} onBack={() => setSelectedPatient(null)} onUpdated={handlePatientUpdated} />}
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

function BillingView({ clinicId, clinicName, currency }: { clinicId: string; clinicName: string; currency: string }) {
  const [patients, setPatients] = useState<Patient[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null)
  const [visits, setVisits] = useState<Visit[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [payments, setPayments] = useState<Record<string, Payment[]>>({})
  const [appointmentStatuses, setAppointmentStatuses] = useState<Record<string, AppointmentStatus>>({})
  const [loadingPatients, setLoadingPatients] = useState(true)
  const [loadingBilling, setLoadingBilling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [billingVisit, setBillingVisit] = useState<Visit | null>(null)
  const patientId = selectedPatient?.id

  useEffect(() => {
    let cancelled = false

    async function loadPatients() {
      if (!supabase) {
        setLoadingPatients(false)
        setError('Supabase is not configured.')
        return
      }
      const { data, error: queryError } = await supabase.from('patients').select('*').eq('clinic_id', clinicId).order('created_at', { ascending: false })
      if (cancelled) return
      setLoadingPatients(false)
      if (queryError) {
        setError('We could not load patients for billing.')
        return
      }
      setPatients((data ?? []) as Patient[])
    }

    void loadPatients()
    return () => { cancelled = true }
  }, [clinicId])

  useEffect(() => {
    if (!patientId) return
    const billingPatientId = patientId
    let cancelled = false

    async function loadBillingRecords() {
      setLoadingBilling(true)
      setError(null)
      if (!supabase) {
        setLoadingBilling(false)
        setError('Supabase is not configured.')
        return
      }

      const [visitResult, invoiceResult, paymentResult] = await Promise.all([
        supabase.from('visits').select('*').eq('clinic_id', clinicId).eq('patient_id', billingPatientId).order('visit_date', { ascending: false }),
        supabase.from('invoices').select('*').eq('clinic_id', clinicId).eq('patient_id', billingPatientId).order('created_at', { ascending: false }),
        supabase.from('payments').select('*').eq('clinic_id', clinicId).eq('patient_id', billingPatientId).order('created_at', { ascending: true }),
      ])
      if (cancelled) return
      if (visitResult.error || invoiceResult.error || paymentResult.error) {
        setLoadingBilling(false)
        setError('We could not load this patient\'s billing history.')
        return
      }

      const visitRows = (visitResult.data ?? []) as Visit[]
      const invoiceRows = (invoiceResult.data ?? []) as Invoice[]
      const paymentRows = (paymentResult.data ?? []) as Payment[]
      const appointmentIds = [...new Set(visitRows.map((visit) => visit.appointment_id).filter((id): id is string => Boolean(id)))]
      let statuses: Record<string, AppointmentStatus> = {}
      if (appointmentIds.length > 0) {
        const { data: appointmentRows, error: appointmentError } = await supabase.from('appointments').select('*').eq('clinic_id', clinicId).in('id', appointmentIds)
        if (cancelled) return
        if (appointmentError) {
          setLoadingBilling(false)
          setError('We could not verify appointment completion for billing.')
          return
        }
        statuses = Object.fromEntries(((appointmentRows ?? []) as Appointment[]).map((appointment) => [appointment.id, appointment.status]))
      }

      setVisits(visitRows)
      setInvoices(invoiceRows)
      setPayments(Object.fromEntries(invoiceRows.map((invoice) => [invoice.id, paymentRows.filter((payment) => payment.invoice_id === invoice.id)])))
      setAppointmentStatuses(statuses)
      setLoadingBilling(false)
    }

    void loadBillingRecords()
    return () => { cancelled = true }
  }, [clinicId, patientId])

  const normalizedSearch = searchTerm.trim().toLowerCase()
  const visiblePatients = patients.filter((patient) => [patient.patient_number, patient.first_name, patient.middle_name, patient.last_name, patient.phone]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(normalizedSearch)))
  const invoiceableVisits = visits.filter((visit) => {
    const hasInvoice = invoices.some((invoice) => invoice.visit_id === visit.id)
    return hasInvoice || !visit.appointment_id || appointmentStatuses[visit.appointment_id] === 'completed'
  })
  const unlinkedInvoices = invoices.filter((invoice) => !invoice.visit_id)

  function handleInvoiceCreated(invoice: Invoice) {
    setBillingVisit(null)
    setInvoices((current) => [invoice, ...current])
    setPayments((current) => ({ ...current, [invoice.id]: [] }))
  }

  function handlePaymentRecorded(invoice: Invoice, payment: Payment) {
    setInvoices((current) => current.map((currentInvoice) => currentInvoice.id === invoice.id ? invoice : currentInvoice))
    setPayments((current) => ({ ...current, [invoice.id]: [...(current[invoice.id] ?? []), payment] }))
  }

  return (
    <div className="patients-page">
      <div className="page-heading"><div><p className="eyebrow">Management</p><h1>Billing</h1><p className="panel-copy">Clinic currency: {currency}. Find a patient to review visits, invoices, and payments.</p></div></div>
      {!selectedPatient ? <>
        <div className="patient-toolbar"><label className="search-field"><span>Search patients</span><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="File number, name, or phone" type="search" /></label><p className="result-count">{loadingPatients ? 'Loading...' : `${visiblePatients.length} ${visiblePatients.length === 1 ? 'patient' : 'patients'}`}</p></div>
        {loadingPatients && <div className="state-panel" role="status">Loading patients...</div>}
        {!loadingPatients && error && <div className="state-panel state-error" role="alert">{error}</div>}
        {!loadingPatients && !error && patients.length === 0 && <div className="state-panel"><h2>No patients yet</h2><p>Registered patients will appear here.</p></div>}
        {!loadingPatients && !error && patients.length > 0 && visiblePatients.length === 0 && <div className="state-panel"><h2>No matching patients</h2><p>Try a different file number, name, or phone number.</p></div>}
        {!loadingPatients && !error && visiblePatients.length > 0 && <PatientTable patients={visiblePatients} onSelect={(patient) => { setSelectedPatient(patient); setError(null); setVisits([]); setInvoices([]); setPayments({}); setBillingVisit(null) }} />}
      </> : <>
        <button className="back-button" onClick={() => { setSelectedPatient(null); setError(null) }} type="button">Back to patients</button>
        <div className="profile-header"><div><p className="eyebrow">Patient file</p><h2>{[selectedPatient.first_name, selectedPatient.middle_name, selectedPatient.last_name].filter(Boolean).join(' ')}</h2><p className="profile-number">File number <strong>{selectedPatient.patient_number}</strong></p></div></div>
        {loadingBilling && <p className="inline-state" role="status">Loading billing history...</p>}
        {!loadingBilling && error && <div className="state-panel state-error" role="alert">{error}</div>}
        {!loadingBilling && !error && invoiceableVisits.length === 0 && invoices.length === 0 && <div className="state-panel"><h2>No invoiceable visits</h2><p>Completed appointment visits and manual visits will appear here.</p></div>}
        {!loadingBilling && !error && invoiceableVisits.length > 0 && <section className="profile-card visit-history"><div className="section-heading"><div><p className="card-label">Billing</p><h3>Invoiceable visits</h3></div><span className="history-count">{invoiceableVisits.length} {invoiceableVisits.length === 1 ? 'visit' : 'visits'}</span></div><div className="visit-list">{invoiceableVisits.map((visit, index) => <VisitCard key={visit.id} clinicId={clinicId} visit={visit} isLatest={index === 0} clinicianLabel="Clinic clinician" prescriptions={[]} investigations={[]} invoices={invoices.filter((invoice) => invoice.visit_id === visit.id)} payments={payments} canBill billingOpen={billingVisit?.id === visit.id} clinicName={clinicName} patient={selectedPatient} onBill={() => setBillingVisit(visit)} onCancelBilling={() => setBillingVisit(null)} onInvoiceCreated={handleInvoiceCreated} onPaymentRecorded={handlePaymentRecorded} />)}</div></section>}
        {!loadingBilling && !error && unlinkedInvoices.length > 0 && <section className="profile-card visit-history"><div className="section-heading"><div><p className="card-label">Financial history</p><h3>Invoices without a visit link</h3></div></div><div className="visit-list">{unlinkedInvoices.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} payments={payments[invoice.id] ?? []} clinicName={clinicName} patient={selectedPatient} canRecordPayment onPaymentRecorded={handlePaymentRecorded} />)}</div></section>}
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

function PatientProfile({ clinicId, clinicName, userId, role, clinicianLabel, patient, onBack, onUpdated }: { clinicId: string; clinicName: string; userId: string; role: UserRole; clinicianLabel: string; patient: Patient; onBack: () => void; onUpdated: (patient: Patient) => void }) {
  const [editing, setEditing] = useState(false)
  const [visits, setVisits] = useState<Visit[]>([])
  const [prescriptions, setPrescriptions] = useState<Record<string, Prescription[]>>({})
  const [investigations, setInvestigations] = useState<Record<string, Investigation[]>>({})
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [payments, setPayments] = useState<Record<string, Payment[]>>({})
  const [billingVisit, setBillingVisit] = useState<Visit | null>(null)
  const [visitLoading, setVisitLoading] = useState(true)
  const [visitError, setVisitError] = useState<string | null>(null)
  const [visitSuccess, setVisitSuccess] = useState<string | null>(null)
  const [showVisitForm, setShowVisitForm] = useState(false)
  const [visitRefreshVersion, setVisitRefreshVersion] = useState(0)
  const [showAppointmentForm, setShowAppointmentForm] = useState(false)
  const [appointmentSuccess, setAppointmentSuccess] = useState<string | null>(null)
  const canViewFinance = role === 'admin' || role === 'receptionist'

  useEffect(() => {
    let cancelled = false

    async function loadVisits() {
      setVisitLoading(true)
      if (!supabase) {
        setVisitLoading(false)
        setVisitError('Supabase is not configured.')
        return
      }

      const [visitResult, prescriptionResult, investigationResult] = await Promise.all([
        supabase.from('visits').select('*').eq('clinic_id', clinicId).eq('patient_id', patient.id).order('visit_date', { ascending: false }),
        supabase.from('prescriptions').select('*').eq('clinic_id', clinicId).eq('patient_id', patient.id).order('created_at', { ascending: true }),
        supabase.from('investigations').select('*').eq('clinic_id', clinicId).eq('patient_id', patient.id).order('created_at', { ascending: true }),
      ])

      if (cancelled) return
      setVisitLoading(false)
      if (visitResult.error || prescriptionResult.error || investigationResult.error) {
        setVisitError('We could not load this patient\'s visit history.')
        return
      }
      const visitRows = (visitResult.data ?? []) as Visit[]
      const prescriptionRows = (prescriptionResult.data ?? []) as Prescription[]
      const investigationRows = (investigationResult.data ?? []) as Investigation[]
      let invoiceRows: Invoice[] = []
      let paymentRows: Payment[] = []
      if (canViewFinance) {
        const [invoiceResult, paymentResult] = await Promise.all([
          supabase.from('invoices').select('*').eq('clinic_id', clinicId).eq('patient_id', patient.id).order('created_at', { ascending: false }),
          supabase.from('payments').select('*').eq('clinic_id', clinicId).eq('patient_id', patient.id).order('created_at', { ascending: true }),
        ])
        if (cancelled) return
        if (invoiceResult.error || paymentResult.error) {
          setVisitError('We could not load this patient\'s visit history.')
          return
        }
        invoiceRows = (invoiceResult.data ?? []) as Invoice[]
        paymentRows = (paymentResult.data ?? []) as Payment[]
      }
      setVisits(visitRows)
      setPrescriptions(Object.fromEntries(visitRows.map((visit) => [visit.id, prescriptionRows.filter((prescription) => prescription.visit_id === visit.id)])))
      setInvestigations(Object.fromEntries(visitRows.map((visit) => [visit.id, investigationRows.filter((investigation) => investigation.visit_id === visit.id)])))
      setInvoices(invoiceRows)
      setPayments(Object.fromEntries(invoiceRows.map((invoice) => [invoice.id, paymentRows.filter((payment) => payment.invoice_id === invoice.id)])))
    }

    void loadVisits()
    return () => {
      cancelled = true
    }
  }, [canViewFinance, clinicId, patient.id, visitRefreshVersion])

  function handleVisitCreated(visit: Visit) {
    setShowVisitForm(false)
    setVisitSuccess(`Visit from ${formatDateTime(visit.visit_date)} was added to the patient history.`)
    setVisitRefreshVersion((version) => version + 1)
  }

  function handleInvoiceCreated(invoice: Invoice) {
    setBillingVisit(null)
    setInvoices((current) => [invoice, ...current])
    setPayments((current) => ({ ...current, [invoice.id]: [] }))
  }

  function handlePaymentRecorded(invoice: Invoice, payment: Payment) {
    setInvoices((current) => current.map((currentInvoice) => currentInvoice.id === invoice.id ? invoice : currentInvoice))
    setPayments((current) => ({ ...current, [invoice.id]: [...(current[invoice.id] ?? []), payment] }))
  }

  const unlinkedInvoices = invoices.filter((invoice) => !invoice.visit_id)

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
          {!visitLoading && !visitError && visits.length > 0 && <div className="visit-list">{visits.map((visit, index) => <VisitCard key={visit.id} clinicId={clinicId} visit={visit} isLatest={index === 0} clinicianLabel={visit.doctor_id === userId ? clinicianLabel : 'Clinic clinician'} prescriptions={prescriptions[visit.id] ?? []} investigations={investigations[visit.id] ?? []} invoices={invoices.filter((invoice) => invoice.visit_id === visit.id)} payments={payments} canBill={role === 'admin' || role === 'receptionist'} billingOpen={billingVisit?.id === visit.id} clinicName={clinicName} patient={patient} userId={userId} role={role} onBill={() => setBillingVisit(visit)} onCancelBilling={() => setBillingVisit(null)} onInvoiceCreated={handleInvoiceCreated} onPaymentRecorded={handlePaymentRecorded} />)}</div>}
        </section>
        {canViewFinance && !visitLoading && !visitError && unlinkedInvoices.length > 0 && <section className="profile-card visit-history"><div className="section-heading"><div><p className="card-label">Financial history</p><h3>Invoices without a visit link</h3></div></div><div className="visit-list">{unlinkedInvoices.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} payments={payments[invoice.id] ?? []} clinicName={clinicName} patient={patient} canRecordPayment={role === 'admin' || role === 'receptionist'} onPaymentRecorded={handlePaymentRecorded} />)}</div></section>}
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

function InvoiceForm({ clinicId, patient, visit, onCancel, onCreated }: { clinicId: string; patient: Patient; visit: Visit; onCancel: () => void; onCreated: (invoice: Invoice) => void }) {
  const [total, setTotal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const amount = Number(total)
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter an invoice total greater than zero.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }
    setSubmitting(true)
    setError(null)
    const { data, error: createError } = await supabase.rpc('create_invoice', {
      p_clinic_id: clinicId,
      p_patient_id: patient.id,
      p_visit_id: visit.id,
      p_total: amount,
    } as never)
    setSubmitting(false)
    if (createError || !data) {
      setError('We could not create this invoice. Confirm that the visit is completed and try again.')
      return
    }
    onCreated(data as Invoice)
  }

  return <section className="registration-panel billing-form-panel" aria-labelledby="invoice-heading"><div className="registration-heading"><p className="eyebrow">Billing</p><h2 id="invoice-heading">Create invoice</h2><p className="panel-copy">{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} · Visit {formatDateTime(visit.visit_date)}</p></div><form className="patient-form" onSubmit={handleSubmit}><label>Invoice total<input type="number" min="0.01" step="0.01" value={total} onChange={(event) => setTotal(event.target.value)} required /></label><div className="form-actions"><button className="button-secondary" onClick={onCancel} type="button">Cancel</button><button type="submit" disabled={submitting}>{submitting ? 'Creating invoice...' : 'Create invoice'}</button></div></form>{error && <p className="form-error" role="alert">{error}</p>}</section>
}

function VisitCard({ clinicId, visit, isLatest, clinicianLabel, prescriptions, investigations, invoices, payments, canBill, billingOpen, clinicName, patient, userId, role, onBill, onCancelBilling, onInvoiceCreated, onPaymentRecorded }: { clinicId: string; visit: Visit; isLatest: boolean; clinicianLabel: string; prescriptions: Prescription[]; investigations: Investigation[]; invoices: Invoice[]; payments: Record<string, Payment[]>; canBill: boolean; billingOpen: boolean; clinicName: string; patient: Patient; userId?: string; role?: UserRole; onBill: () => void; onCancelBilling: () => void; onInvoiceCreated: (invoice: Invoice) => void; onPaymentRecorded: (invoice: Invoice, payment: Payment) => void }) {
  const canViewDentalChart = (role === 'admin' || role === 'doctor') && Boolean(userId)
  const canAddDentalEntries = role === 'admin' || (role === 'doctor' && visit.doctor_id === userId)

  return (
    <article className={`visit-card${isLatest ? ' latest' : ''}`}>
      <div className="visit-card-header"><div><p className="visit-date">{formatDateTime(visit.visit_date)}</p><p className="visit-clinician">Recorded by {clinicianLabel}</p></div>{isLatest && <span className="latest-badge">Latest</span>}</div>
      <div className="visit-fields">{visit.chief_complaint && <div><span>Chief complaint</span><p>{visit.chief_complaint}</p></div>}{visit.assessment && <div><span>Assessment</span><p>{visit.assessment}</p></div>}{visit.treatment_plan && <div><span>Treatment plan</span><p>{visit.treatment_plan}</p></div>}{visit.clinical_notes && <div><span>Clinical notes</span><p>{visit.clinical_notes}</p></div>}</div>
      <VisitRecordsSummary prescriptions={prescriptions} investigations={investigations} />
      {canViewDentalChart && userId && <DentalChart clinicId={clinicId} visit={visit} userId={userId} canCreate={canAddDentalEntries && visit.appointment_id === null} />}
      {canBill && <div className="visit-invoices"><div className="section-heading"><div><span>Financial history</span><h4>Invoices</h4></div>{invoices.length === 0 && <button className="button-secondary inline-button" onClick={onBill} type="button">Create invoice</button>}</div>{invoices.length === 0 ? <p className="inline-state">No invoice for this visit.</p> : invoices.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} payments={payments[invoice.id] ?? []} clinicName={clinicName} patient={patient} canRecordPayment={canBill} onPaymentRecorded={onPaymentRecorded} />)}{billingOpen && <InvoiceForm clinicId={clinicId} patient={patient} visit={visit} onCancel={onCancelBilling} onCreated={onInvoiceCreated} />}</div>}
    </article>
  )
}

function InvoiceCard({ invoice, payments, clinicName, patient, canRecordPayment, onPaymentRecorded }: { invoice: Invoice; payments: Payment[]; clinicName: string; patient: Patient; canRecordPayment: boolean; onPaymentRecorded: (invoice: Invoice, payment: Payment) => void }) {
  const [receiptPayment, setReceiptPayment] = useState<Payment | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handlePaymentRecorded(payment: Payment) {
    if (!supabase) return
    const { data: updatedInvoice, error: invoiceError } = await supabase.from('invoices').select('*').eq('id', invoice.id).single()
    if (invoiceError || !updatedInvoice) {
      setError('Payment recorded, but the updated invoice could not be loaded.')
      return
    }
    setReceiptPayment(payment)
    onPaymentRecorded(updatedInvoice as Invoice, payment)
  }

  const canRecordInvoicePayment = canRecordPayment && invoice.balance > 0 && (invoice.status === 'draft' || invoice.status === 'partially_paid')

  return <section className="invoice-card"><div className="invoice-header"><div><span>Invoice</span><strong>{invoice.invoice_number}</strong></div><span className={`invoice-status invoice-${invoice.status}`}>{formatStatus(invoice.status)}</span></div><div className="invoice-totals"><div><span>Total</span><strong>{formatMoney(invoice.total, invoice.currency)}</strong></div><div><span>Paid</span><strong>{formatMoney(invoice.amount_paid, invoice.currency)}</strong></div><div><span>Balance</span><strong>{formatMoney(invoice.balance, invoice.currency)}</strong></div></div>{payments.length > 0 && <div className="payment-list"><span>Payments</span>{payments.map((payment) => <p key={payment.id}>{formatMoney(payment.amount, invoice.currency)} · {formatStatus(payment.payment_method)}{payment.reference ? ` · ${payment.reference}` : ''} · {formatDateTime(payment.payment_date)}</p>)}</div>}{canRecordInvoicePayment && <PaymentForm invoice={invoice} onRecorded={handlePaymentRecorded} />}{receiptPayment && <PaymentConfirmation clinicName={clinicName} patient={patient} invoice={invoice} payment={receiptPayment} />}{error && <p className="form-error" role="alert">{error}</p>}</section>
}

function PaymentForm({ invoice, onRecorded }: { invoice: Invoice; onRecorded: (payment: Payment) => void }) {
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [reference, setReference] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const methods: PaymentMethod[] = ['cash', 'mobile_money', 'card', 'bank', 'insurance', 'other']

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const paymentAmount = Number(amount)
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      setError('Enter a payment amount greater than zero.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }
    setSubmitting(true)
    setError(null)
    const { data, error: paymentError } = await supabase.rpc('record_payment', {
      p_invoice_id: invoice.id,
      p_amount: paymentAmount,
      p_payment_method: method,
      p_reference: reference.trim() || null,
    } as never)
    setSubmitting(false)
    if (paymentError || !data) {
      setError('We could not record this payment. Check the remaining balance and try again.')
      return
    }
    setAmount('')
    setReference('')
    onRecorded(data as Payment)
  }

  return <form className="payment-form" onSubmit={handleSubmit}><input type="number" min="0.01" step="0.01" placeholder="Amount" value={amount} onChange={(event) => setAmount(event.target.value)} required /><select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>{methods.map((paymentMethod) => <option key={paymentMethod} value={paymentMethod}>{formatStatus(paymentMethod)}</option>)}</select><input placeholder="Reference (optional)" value={reference} onChange={(event) => setReference(event.target.value)} /><button type="submit" disabled={submitting}>{submitting ? 'Recording...' : invoice.status === 'partially_paid' ? 'Record Another Payment' : 'Record Payment'}</button>{error && <p className="form-error" role="alert">{error}</p>}</form>
}

function PaymentConfirmation({ clinicName, patient, invoice, payment }: { clinicName: string; patient: Patient; invoice: Invoice; payment: Payment }) {
  return <section className="receipt-panel"><div><span>Payment confirmation</span><strong>{clinicName}</strong></div><p>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} · File {patient.patient_number}</p><p>Invoice {invoice.invoice_number} · {formatMoney(payment.amount, invoice.currency)} via {formatStatus(payment.payment_method)}</p><p>{formatDateTime(payment.payment_date)} · Paid {formatMoney(invoice.amount_paid, invoice.currency)} · Balance {formatMoney(invoice.balance, invoice.currency)}</p><button className="button-secondary inline-button" onClick={() => window.print()} type="button">Print confirmation</button></section>
}

function VisitRecordsSummary({ prescriptions, investigations }: { prescriptions: Prescription[]; investigations: Investigation[] }) {
  return <div className="visit-record-summary"><div><span>Prescriptions</span>{prescriptions.length === 0 ? <p>None recorded</p> : prescriptions.map((prescription) => <p key={prescription.id}><strong>{prescription.medicine}</strong>{prescription.dose ? ` · ${prescription.dose}` : ''}{prescription.frequency ? ` · ${prescription.frequency}` : ''}</p>)}</div><div><span>Investigations</span>{investigations.length === 0 ? <p>None requested</p> : investigations.map((investigation) => <p key={investigation.id}><strong>{investigation.investigation_type}</strong>{investigation.status ? ` · ${investigation.status}` : ''}</p>)}</div></div>
}

const dentalSurfaceOptions: Array<{ value: DentalSurface; label: string }> = [
  { value: 'mesial', label: 'Mesial' },
  { value: 'distal', label: 'Distal' },
  { value: 'buccal_facial', label: 'Buccal / facial' },
  { value: 'lingual_palatal', label: 'Lingual / palatal' },
  { value: 'occlusal', label: 'Occlusal' },
  { value: 'incisal', label: 'Incisal' },
]

const adultDentalQuadrants = [
  { label: 'Upper right', teeth: [18, 17, 16, 15, 14, 13, 12, 11] },
  { label: 'Upper left', teeth: [21, 22, 23, 24, 25, 26, 27, 28] },
  { label: 'Lower right', teeth: [48, 47, 46, 45, 44, 43, 42, 41] },
  { label: 'Lower left', teeth: [31, 32, 33, 34, 35, 36, 37, 38] },
]

function DentalChart({ clinicId, visit, userId, canCreate, defaultOpen = false }: { clinicId: string; visit: Visit; userId: string; canCreate: boolean; defaultOpen?: boolean }) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [entries, setEntries] = useState<DentalChartEntry[]>([])
  const [visitDates, setVisitDates] = useState<Record<string, string>>({})
  const [selectedTooth, setSelectedTooth] = useState<number | null>(null)
  const [surfaces, setSurfaces] = useState<DentalSurface[]>([])
  const [finding, setFinding] = useState('')
  const [procedureText, setProcedureText] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false

    async function loadEntries() {
      if (!supabase) {
        setError('Supabase is not configured.')
        return
      }
      setLoading(true)
      const { data: visitRows, error: visitsError } = await supabase
        .from('visits')
        .select('id, visit_date')
        .eq('clinic_id', clinicId)
        .eq('patient_id', visit.patient_id)

      if (cancelled) return
      if (visitsError) {
        setLoading(false)
        setError('We could not load this patient\'s visit history.')
        return
      }

      const patientVisits = (visitRows ?? []) as Array<Pick<Visit, 'id' | 'visit_date'>>
      const { data, error: queryError } = await supabase
        .from('dental_chart_entries')
        .select('*')
        .eq('clinic_id', clinicId)
        .in('visit_id', patientVisits.map((patientVisit) => patientVisit.id))
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })

      if (cancelled) return
      setLoading(false)
      if (queryError) {
        setError('We could not load this visit\'s dental chart.')
        return
      }
      setError(null)
      setVisitDates(Object.fromEntries(patientVisits.map((patientVisit) => [patientVisit.id, patientVisit.visit_date])))
      setEntries((data ?? []) as DentalChartEntry[])
    }

    void loadEntries()
    return () => { cancelled = true }
  }, [clinicId, isOpen, refreshVersion, visit.id, visit.patient_id])

  const availableSurfaces = selectedTooth === null
    ? dentalSurfaceOptions.filter((surface) => surface.value !== 'occlusal' && surface.value !== 'incisal')
    : dentalSurfaceOptions.filter((surface) => {
      if (surface.value === 'occlusal') return selectedTooth % 10 >= 4
      if (surface.value === 'incisal') return selectedTooth % 10 <= 3
      return true
    })

  async function saveEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedFinding = finding.trim()
    const trimmedProcedure = procedureText.trim()
    if (selectedTooth === null || (!trimmedFinding && !trimmedProcedure)) {
      setError('Select a tooth and enter a finding or treatment/procedure.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }

    setSaving(true)
    setError(null)
    setMessage(null)
    const { error: insertError } = await supabase.from('dental_chart_entries').insert({
      clinic_id: clinicId,
      visit_id: visit.id,
      tooth_number: selectedTooth,
      surfaces,
      entry_type: trimmedFinding && trimmedProcedure ? 'finding_and_procedure' : trimmedFinding ? 'finding' : 'procedure',
      finding: trimmedFinding || null,
      procedure_text: trimmedProcedure || null,
      notes: notes.trim() || null,
      recorded_by: userId,
    } as never)
    setSaving(false)
    if (insertError) {
      setError('We could not save this dental entry. Confirm the visit is open and try again.')
      return
    }

    setFinding('')
    setProcedureText('')
    setNotes('')
    setSurfaces([])
    setMessage('Dental entry saved.')
    setRefreshVersion((version) => version + 1)
  }

  return (
    <section className={`dental-chart${defaultOpen ? ' dental-chart-active' : ''}`}>
      {!defaultOpen && <button className="dental-chart-toggle" type="button" aria-expanded={isOpen} onClick={() => setIsOpen((open) => !open)}>Dental chart {isOpen ? '−' : '+'}</button>}
      {isOpen && <>
        {defaultOpen && <div className="dental-chart-heading"><div><p className="card-label">Dental chart</p><h3>Odontogram</h3></div><span>Visit {formatDateTime(visit.visit_date)}</span></div>}
        <div className="odontogram-quadrants">{adultDentalQuadrants.map((quadrant) => <section className="odontogram-quadrant" key={quadrant.label}><h4>{quadrant.label}</h4><div>{quadrant.teeth.map((toothNumber) => {
          const hasEntries = entries.some((entry) => entry.tooth_number === toothNumber)
          return <button className={`odontogram-tooth${selectedTooth === toothNumber ? ' selected' : ''}${hasEntries ? ' has-entry' : ''}`} key={toothNumber} type="button" aria-pressed={selectedTooth === toothNumber} aria-label={`Tooth ${toothNumber}${hasEntries ? ', has recorded entries' : ''}`} onClick={() => { setSelectedTooth(toothNumber); setSurfaces([]) }}>{toothNumber}</button>
        })}</div></section>)}</div>
        {canCreate && <form className="dental-entry-form" onSubmit={saveEntry}>
          <h4>{selectedTooth === null ? 'Select a tooth' : `Tooth ${selectedTooth}`}</h4>
          <fieldset disabled={selectedTooth === null || saving}>
            <legend>Surfaces (optional)</legend>
            <div className="dental-surface-options">{availableSurfaces.map((surface) => <label key={surface.value}><input type="checkbox" checked={surfaces.includes(surface.value)} onChange={(event) => setSurfaces((current) => event.target.checked ? [...current, surface.value] : current.filter((value) => value !== surface.value))} />{surface.label}</label>)}</div>
          </fieldset>
          <div className="dental-entry-fields"><label>Finding / condition<input value={finding} onChange={(event) => setFinding(event.target.value)} maxLength={500} placeholder="For example, caries" disabled={selectedTooth === null || saving} /></label><label>Treatment / procedure<input value={procedureText} onChange={(event) => setProcedureText(event.target.value)} maxLength={500} placeholder="For example, restoration" disabled={selectedTooth === null || saving} /></label><label className="dental-notes">Notes (optional)<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} maxLength={2000} disabled={selectedTooth === null || saving} /></label></div>
          <button type="submit" disabled={saving || selectedTooth === null || (!finding.trim() && !procedureText.trim())}>{saving ? 'Saving...' : 'Save Entry'}</button>
        </form>}
        {loading && <p className="inline-state" role="status">Loading dental history...</p>}
        {!loading && entries.length === 0 && <p className="inline-state">No dental entries recorded for this patient.</p>}
        {entries.length > 0 && <div className="dental-entry-history"><h4>Patient dental history</h4>{entries.map((entry) => <article className="dental-entry" key={entry.id}><div><strong>Tooth {entry.tooth_number}</strong><time>{visitDates[entry.visit_id] ? `Visit ${formatDateTime(visitDates[entry.visit_id])} · ` : ''}Recorded {formatDateTime(entry.created_at)}</time></div>{entry.surfaces.length > 0 && <span>{entry.surfaces.map((surface) => dentalSurfaceOptions.find((option) => option.value === surface)?.label ?? surface).join(', ')}</span>}{entry.finding && <p><b>Finding:</b> {entry.finding}</p>}{entry.procedure_text && <p><b>Treatment / procedure:</b> {entry.procedure_text}</p>}{entry.notes && <p><b>Notes:</b> {entry.notes}</p>}</article>)}</div>}
        {message && <p className="dental-message" role="status">{message}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </>}
    </section>
  )
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

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value)
}

function StatusScreen({ message, action }: { message: string; action?: React.ReactNode }) {
  return <main className="auth-page"><section className="auth-panel"><p className="eyebrow">SmartDental HMIS</p><p className="panel-copy">{message}</p>{action}</section></main>
}

export default App
