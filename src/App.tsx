import { useEffect, useRef, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'

import { PasswordEstablishment, PasswordRecovery } from './PasswordAccess'
import { ClinicalCorrectionAction, CorrectionHistory } from './ClinicalCorrections'
import { effectiveRecord, latestCorrection, loadCorrections, readPages, pagedResult, batchedResult } from './lib/clinicalCorrections'
import { searchPatients } from './lib/patientSearch'
import { useCorrections, correctionsChanged } from './lib/useCorrections'
import './App.css'
import { VisitProcedures, ProcedureCatalogSettings, ProcedureActivitySummary } from './Procedures'
import { procedureClient } from './lib/procedures'
import type { ProcedureActivity } from './lib/procedures'
import './SoapSmileWorkstation.css'
import './SoapSmileThemes.css'
import { getCurrentSession, signIn, signOut, subscribeToAuthChanges } from './lib/auth'
import { bookEncounterAppointment, correctDentalChartEntry, startEncounterContext, supabase, updatePatientClinicalProfile } from './lib/supabase'
import { inspectDentalEntryChains } from './lib/odontogram'
import { SoapSmileBillingPatientList, SoapSmileBrand, SoapSmileCompanion, SoapSmileCompanionDock, SoapSmileEmptyState, SoapSmileFeedback, SoapSmileIcon, SoapSmileInvoiceSummary, SoapSmileLoader, SoapSmileLoadingState, SoapSmileLoginEnvironment, SoapSmileOperationsCore, SoapSmileTooth } from './SoapSmilePresentation'
import { SoapSmileThemePicker, SoapSmileThemeToggle } from './SoapSmileTheme'
import { useSoapSmileTheme } from './useSoapSmileTheme'
import type { SoapSmileTheme } from './useSoapSmileTheme'
import type { Appointment, AppointmentStatus, AuditLog, Clinic, ClinicMembership, ClinicalProfileField, DentalChartEntry, DentalSurface, EncounterContext, Investigation, Invoice, Patient, PatientClinicalProfileVersion, Payment, PaymentMethod, Prescription, StandaloneVisitLifecycle, UserRole, Visit } from './types/domain'

type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated' | 'error'
const clinicCurrencies = ['TZS', 'KES', 'UGX', 'USD'] as const
type ClinicCurrency = (typeof clinicCurrencies)[number]

type MembershipContext = {
  clinic: Clinic
  membership: ClinicMembership
  user: User
}

type PrintableDocument =
  | { type: 'receipt'; clinic: Clinic; patient: Patient; invoice: Invoice; payment: Payment }
  | { type: 'visit'; corrections?: import('./lib/clinicalCorrections').ClinicalCorrection[]; standaloneState?: 'saved' | 'finalized' | 'unknown'; clinic: Clinic; patient: Patient; visit: Visit; clinicianName: string; prescriptions: Prescription[]; investigations: Investigation[] }
  | { type: 'report'; view: ReportView; clinic: Clinic; data: ReportsData; startDate: string; endDate: string; generatedAt: string }

type ViewReceipt = (patient: Patient, invoice: Invoice, payment: Payment) => void
type PrintVisitSummary = (patient: Patient, visit: Visit, clinicianName: string, prescriptions: Prescription[], investigations: Investigation[]) => void
type ReportView = 'overview' | 'procedures'
type PrintReport = (data: ReportsData, startDate: string, endDate: string, view: ReportView) => void

// Navigation discards UI drafts only. Committed records remain server-protected.
function confirmWorkspaceLeave(ignoreNotes = false) {
  return window.dispatchEvent(new CustomEvent('soapsmile-before-navigation', { cancelable: true, detail: { confirmed: false, ignoreNotes } }))
}

function useUnsavedWorkspace(dirty: boolean, busy = false, isConsultationNotes = false) {
  useEffect(() => {
    function beforeNavigation(event: Event) {
      const navigation = event as CustomEvent<{ confirmed: boolean; ignoreNotes: boolean }>
      if (navigation.defaultPrevented) return
      if (busy) { window.alert('Please wait for the current save to finish.'); event.preventDefault(); return }
      if (isConsultationNotes && navigation.detail.ignoreNotes) return
      if (!dirty || navigation.detail.confirmed) return
      if (window.confirm('Leave this workspace and discard unsaved changes? Saved records will remain unchanged.')) navigation.detail.confirmed = true
      else event.preventDefault()
    }
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!dirty && !busy) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('soapsmile-before-navigation', beforeNavigation)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('soapsmile-before-navigation', beforeNavigation)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [dirty, busy, isConsultationNotes])
}

function App() {
  const [passwordSetup, setPasswordSetup] = useState(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    return ['invite','recovery'].includes(fragment.get('type') ?? '') || new URLSearchParams(window.location.search).has('password_setup') || fragment.has('error')
  })
  const [invalidAccessLink] = useState(() => new URLSearchParams(window.location.hash.slice(1)).has('error'))
  useEffect(() => {
    if (passwordSetup) {
      const url=new URL(window.location.href)
      url.searchParams.set('password_setup','1')
      window.history.replaceState(null,'',url)
    }
  },[passwordSetup])
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
    const unsubscribe = subscribeToAuthChanges((event, nextSession) => {
      if (!mounted) return
      if (event === 'PASSWORD_RECOVERY') setPasswordSetup(true)
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
        .select('user_id, clinic_id, role, is_active, created_at')
        .eq('user_id', authenticatedUser.id)
        .order('is_active', { ascending: false })
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
      if (!membership.is_active) {
        setMembershipContext(null)
        setMembershipLoading(false)
        setMembershipError('Your clinic access is inactive. Contact a clinic administrator.')
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

  async function handleInactiveSignOut() {
    const error = await signOut()
    if (error) setMembershipError('Sign-out failed. Please try again.')
  }

  if (authStatus === 'loading') return <StatusScreen message="Loading your session..." />
  if (passwordSetup) return <PasswordEstablishment authenticated={Boolean(session) && !invalidAccessLink} onComplete={() => { window.history.replaceState(null,'',window.location.pathname); setPasswordSetup(false); setAuthError('Password access complete. Sign in with your credentials.'); }} />
  if (authStatus === 'error') return <StatusScreen message={authError ?? 'Authentication is temporarily unavailable.'} />
  if (authStatus === 'unauthenticated') return <LoginScreen error={authError} onError={setAuthError} />
  if (membershipLoading) return <StatusScreen message="Loading your clinic..." />
  if (membershipError) return <StatusScreen message={membershipError} action={membershipError === 'Your clinic access is inactive. Contact a clinic administrator.' ? <button onClick={() => void handleInactiveSignOut()} type="button">Sign Out</button> : <button onClick={() => window.location.reload()} type="button">Try again</button>} />
  if (!membershipContext) return <ClinicSetupScreen user={session!.user} />

  return <ClinicShell key={membershipContext.user.id + ':' + membershipContext.clinic.id} context={membershipContext} />
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
    <main className="auth-page auth-page-login">
      <div className="login-layout">
        <section className="login-story" aria-label="SoapSmile dental care platform">
          <SoapSmileLoginEnvironment />
          <p className="login-story-kicker"><span /> CLINIC OPERATIONS, CONNECTED</p>
          <h2>Dental care,<br />intelligently connected.</h2>
          <p>Precision for every encounter. Clarity for your entire care team.</p>
          <div className="login-story-proof"><SoapSmileIcon name="shield" /><span>Private clinic workspace</span></div>
          <div className="login-visual-caption">Precision dentistry, thoughtfully connected</div>
        </section>
        <section className="auth-panel">
          <SoapSmileBrand className="login-brand" />
          <p className="eyebrow">CLINIC PORTAL</p>
          <h1>Welcome back</h1>
          <p className="panel-copy">Dental care, intelligently connected.</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          <button className="auth-submit" type="submit" disabled={submitting}><span>{submitting ? 'Signing in...' : 'Sign in'}</span>{submitting ? <SoapSmileLoader size="button" /> : <SoapSmileIcon name="arrow-right" />}</button>
        </form>
        {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
        <PasswordRecovery />
        <div className="login-foot"><SoapSmileIcon name="shield" /><span>Secure access for your care team</span></div>
        </section>
      </div>
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
        <SoapSmileBrand className="login-brand" />
        <h1>Set up your clinic</h1>
        <p className="panel-copy">Create the clinic workspace for {user.email ?? 'your account'}.</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>Clinic name<input value={clinicName} onChange={(event) => setClinicName(event.target.value)} autoComplete="organization" maxLength={200} required /></label>
          <button type="submit" disabled={submitting}>{submitting ? <><SoapSmileLoader size="button" />Creating clinic...</> : 'Create clinic'}</button>
        </form>
        {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
      </section>
    </main>
  )
}

function ClinicShell({ context }: { context: MembershipContext }) {
  const { theme, changeTheme } = useSoapSmileTheme(context.user.id)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [activeModule, setActiveModule] = useState('Dashboard')
  const [patientToOpen, setPatientToOpen] = useState<Patient | null>(null)
  const [appointmentToOpen, setAppointmentToOpen] = useState<Appointment | null>(null)
  const [printableDocument, setPrintableDocument] = useState<PrintableDocument | null>(null)
  const [clinic, setClinic] = useState(context.clinic)
  const canViewFinance = context.membership.role === 'admin' || context.membership.role === 'receptionist'
  const canManageClinicSettings = context.membership.role === 'admin' && context.membership.is_active
  const canViewOdontogram = context.membership.is_active && ['admin', 'doctor'].includes(context.membership.role)

  function navigateToModule(module: string) {
    if (!confirmWorkspaceLeave()) return
    setAppointmentToOpen(null)
    setPatientToOpen(null)
    setActiveModule(module)
  }

  function openPatientHistory(patient: Patient) {
    if (!confirmWorkspaceLeave()) return
    setAppointmentToOpen(null)
    setPatientToOpen(patient)
    setActiveModule('Patients')
  }

  function openAppointment(appointment: Appointment) {
    if (!confirmWorkspaceLeave()) return
    setPatientToOpen(null)
    setAppointmentToOpen(appointment)
    setActiveModule('Appointments')
  }

  function viewReceipt(patient: Patient, invoice: Invoice, payment: Payment) {
    setPrintableDocument({ type: 'receipt', clinic, patient, invoice, payment })
  }

  async function printVisitSummary(patient: Patient, visit: Visit, clinicianName: string, prescriptions: Prescription[], investigations: Investigation[]) {
    let standaloneState: 'saved' | 'finalized' | 'unknown' | undefined
    if (!visit.appointment_id) {
      standaloneState = 'unknown'
      if (supabase) {
        const result = await supabase.from('standalone_visit_lifecycle').select('state').eq('clinic_id', clinic.id).eq('visit_id', visit.id).single()
        const row = result.data as Pick<StandaloneVisitLifecycle, 'state'> | null
        if (!result.error && row) standaloneState = row.state
      }
    }
    try {
      if (!supabase) throw new Error('Supabase unavailable')
      const [corrections, original, px, requests] = await Promise.all([
        loadCorrections(clinic.id,visit.id),
        supabase.from('visits').select('*').eq('clinic_id',clinic.id).eq('id',visit.id).single(),
        readPages(() => supabase!.from('prescriptions').select('*').eq('clinic_id',clinic.id).eq('visit_id',visit.id).order('id')),
        readPages(() => supabase!.from('investigations').select('*').eq('clinic_id',clinic.id).eq('visit_id',visit.id).order('id')),
      ])
      const originalVisit=original.data as Visit | null
      if (original.error || !originalVisit) throw new Error('Visit unavailable')
      visit=effectiveRecord(originalVisit,corrections,'visit')!
      prescriptions=px.map((row) => effectiveRecord(row as Prescription,corrections,'prescription')).filter((row): row is Prescription => Boolean(row))
      investigations=requests.map((row) => effectiveRecord(row as Investigation,corrections,'investigation')).filter((row): row is Investigation => Boolean(row))
      setPrintableDocument({ type: 'visit', clinic, patient, visit, clinicianName, prescriptions, investigations, standaloneState, corrections })
    } catch { window.alert('Current clinical history could not be verified. Refresh before printing.') }
  }

  function printReport(data: ReportsData, startDate: string, endDate: string, view: ReportView) {
    setPrintableDocument({ type: 'report', view, clinic, data, startDate, endDate, generatedAt: new Date().toISOString() })
  }

  async function handleLogout() {
    if (!confirmWorkspaceLeave()) return
    const error = await signOut()
    if (error) setLogoutError('Sign-out failed. Please try again.')
  }

  return <>
    <main className="shell" data-theme={theme}>
      <div className="shell-atmosphere" aria-hidden="true"><span /><span /><span /></div>
      <aside className="sidebar">
        <div className="brand-lockup"><SoapSmileBrand /><div className="clinic-identity"><p className="clinic-label">YOUR CLINIC</p><p className="clinic-name">{clinic.name}</p></div></div>
        <nav aria-label="Clinic modules">
          <p className="nav-label">Workspace</p>
          <button className={`nav-item nav-button${activeModule === 'Dashboard' ? ' active' : ''}`} onClick={() => navigateToModule('Dashboard')} type="button"><SoapSmileIcon name="dashboard" />Dashboard</button>
          <button className={`nav-item nav-button${activeModule === 'Clinical Visits' ? ' active' : ''}`} onClick={() => navigateToModule('Clinical Visits')} type="button"><SoapSmileIcon name="clinical" />Clinical Visits</button>
          <button className={`nav-item nav-button${activeModule === 'Appointments' ? ' active' : ''}`} onClick={() => navigateToModule('Appointments')} type="button"><SoapSmileIcon name="appointments" />Appointments</button>
          {canViewOdontogram && <button className={`nav-item nav-button${activeModule === 'Odontogram' ? ' active' : ''}`} aria-current={activeModule === 'Odontogram' ? 'page' : undefined} onClick={() => navigateToModule('Odontogram')} type="button"><SoapSmileIcon name="odontogram" />Odontogram</button>}
          <p className="nav-label nav-label-spaced">Management</p>
          {canViewFinance && <button className={`nav-item nav-button${activeModule === 'Billing' ? ' active' : ''}`} onClick={() => navigateToModule('Billing')} type="button"><SoapSmileIcon name="billing" />Billing</button>}
          {canViewFinance && <button className={`nav-item nav-button${activeModule === 'Reports' ? ' active' : ''}`} onClick={() => navigateToModule('Reports')} type="button"><SoapSmileIcon name="reports" />Reports</button>}
          {context.membership.role === 'admin' && <button className={`nav-item nav-button${activeModule === 'Staff' ? ' active' : ''}`} onClick={() => navigateToModule('Staff')} type="button"><SoapSmileIcon name="staff" />Staff</button>}
          {canManageClinicSettings && <button className={`nav-item nav-button${activeModule === 'Audit / Activity' ? ' active' : ''}`} onClick={() => navigateToModule('Audit / Activity')} type="button"><SoapSmileIcon name="activity" />Audit / Activity</button>}
          {canManageClinicSettings && <button className={`nav-item nav-button${activeModule === 'Settings' ? ' active' : ''}`} onClick={() => navigateToModule('Settings')} type="button"><SoapSmileIcon name="settings" />Settings</button>}
          {['Prescriptions', 'Investigations'].map((item) => <button className={`nav-item nav-button${activeModule === item ? ' active' : ''}`} key={item} onClick={() => navigateToModule(item)} type="button"><SoapSmileIcon name={item === 'Prescriptions' ? 'prescriptions' : 'investigations'} />{item}</button>)}
          <button className={`nav-item nav-button${activeModule === 'Patients' ? ' active' : ''}`} onClick={() => navigateToModule('Patients')} type="button"><SoapSmileIcon name="patients" />Patients</button>
        </nav>
        <div className="user-area"><div className="user-summary"><div className="avatar">{(context.user.email?.[0] ?? 'U').toUpperCase()}</div><div><p>{context.user.email ?? 'Signed-in user'}</p><p className="role">{context.membership.role}</p></div></div><button className="button-secondary logout-button" onClick={handleLogout}><SoapSmileIcon name="logout" />Log out</button>{logoutError && <SoapSmileFeedback tone="error">{logoutError}</SoapSmileFeedback>}</div>
      </aside>
      <section className="shell-content">
        <header className="topbar"><div><p className="topbar-kicker">{clinic.name}</p><p className="topbar-title">{activeModule}</p></div><div className="soap-topbar-actions"><SoapSmileThemeToggle theme={theme} onChange={changeTheme} /><div className="topbar-meta"><span className="status-indicator" /><SoapSmileIcon name="shield" />Secure session</div></div></header>
        {activeModule === 'Odontogram' && canViewOdontogram ? <OdontogramWorkspace clinicId={clinic.id} userId={context.user.id} role={context.membership.role} /> : activeModule === 'Appointments' ? <AppointmentsView key={clinic.id} clinicId={clinic.id} timezone={clinic.timezone} initialAppointment={appointmentToOpen} onViewPatient={openPatientHistory} userId={context.user.id} role={context.membership.role} onOpenPatients={() => navigateToModule('Patients')} /> : activeModule === 'Clinical Visits' ? <ClinicalVisitsView clinicId={clinic.id} onPrintVisitSummary={printVisitSummary} onViewPatient={openPatientHistory} onOpenPatients={() => navigateToModule('Patients')} /> : activeModule === 'Patients' ? <PatientsView clinicId={clinic.id} clinicName={clinic.name} clinicTimezone={clinic.timezone} userId={context.user.id} role={context.membership.role} clinicianLabel={context.user.email ?? context.membership.role} patientToOpen={patientToOpen} onViewAppointment={openAppointment} onViewReceipt={viewReceipt} onPrintVisitSummary={printVisitSummary} /> : activeModule === 'Prescriptions' ? <PrescriptionsView clinicId={clinic.id} onViewPatient={openPatientHistory} /> : activeModule === 'Investigations' ? <InvestigationsView clinicId={clinic.id} onViewPatient={openPatientHistory} /> : activeModule === 'Billing' && canViewFinance ? <BillingView clinicId={clinic.id} clinicName={clinic.name} currency={clinic.currency} onViewReceipt={viewReceipt} /> : activeModule === 'Reports' && canViewFinance ? <ReportsView clinicId={clinic.id} timezone={clinic.timezone} onPrintReport={printReport} /> : activeModule === 'Audit / Activity' && canManageClinicSettings ? <AuditActivityView clinicId={clinic.id} clinicName={clinic.name} /> : activeModule === 'Settings' && canManageClinicSettings ? <ClinicSettingsView clinic={clinic} onUpdated={setClinic} theme={theme} onThemeChange={changeTheme} /> : activeModule === 'Staff' && context.membership.role === 'admin' ? <StaffManagementView clinicId={clinic.id} userId={context.user.id} /> : <DashboardView clinicId={clinic.id} clinicName={clinic.name} timezone={clinic.timezone} role={context.membership.role} userId={context.user.id} onOpenPatients={() => navigateToModule('Patients')} onOpenBilling={() => navigateToModule('Billing')} onOpenAppointments={() => navigateToModule('Appointments')} />}
        <SoapSmileCompanionDock />
      </section>
    </main>
    {printableDocument?.type === 'report'
      ? <ReportPrintHost document={printableDocument} onDone={setPrintableDocument} />
      : printableDocument && <PrintableDocumentPreview document={printableDocument} onClose={() => setPrintableDocument(null)} />}
  </>
}

function ClinicSettingsView({ clinic, onUpdated, theme, onThemeChange }: { clinic: Clinic; onUpdated: (clinic: Clinic) => void; theme: SoapSmileTheme; onThemeChange: (theme: SoapSmileTheme) => void }) {
  const [currency, setCurrency] = useState(() => clinicCurrencies.includes(clinic.currency as ClinicCurrency) ? clinic.currency : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!clinicCurrencies.some((supportedCurrency) => supportedCurrency === currency)) {
      setError('Select a supported clinic currency.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }

    setSaving(true)
    setError(null)
    setSuccess(null)
    const { data, error: updateError } = await supabase.rpc('update_clinic_currency', {
      p_clinic_id: clinic.id,
      p_currency: currency,
    } as never)
    setSaving(false)
    if (updateError || !data) {
      setError('We could not update the clinic currency. Please try again.')
      return
    }

    const updatedClinic = data as Clinic
    onUpdated(updatedClinic)
    setCurrency(updatedClinic.currency)
    setSuccess(`Clinic currency updated to ${updatedClinic.currency}.`)
  }

  return <div className="clinic-settings-page">
    <div className="page-heading"><div><p className="eyebrow">Clinic management</p><h1>Settings</h1><p className="panel-copy">Manage settings for {clinic.name}.</p></div></div>
    <SoapSmileThemePicker theme={theme} onChange={onThemeChange} />
    <ProcedureCatalogSettings clinicId={clinic.id} />
    <section className="registration-panel clinic-currency-panel">
      <div className="registration-heading"><p className="eyebrow">Financial settings</p><h2>Operating currency</h2><p className="panel-copy">Currency changes apply to future invoices. Existing invoices keep their recorded currency.</p></div>
      <form className="clinic-currency-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>Clinic currency<select value={currency} onChange={(event) => setCurrency(event.target.value)} required><option value="">Select currency</option>{clinicCurrencies.map((supportedCurrency) => <option key={supportedCurrency} value={supportedCurrency}>{supportedCurrency}</option>)}</select></label>
        <button className="primary-action" type="submit" disabled={saving || !clinicCurrencies.some((supportedCurrency) => supportedCurrency === currency)}>{saving ? <><SoapSmileCompanion state="saving" />Saving...</> : 'Save currency'}</button>
      </form>
      {success && <SoapSmileFeedback tone="success">{success}</SoapSmileFeedback>}
      {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    </section>
  </div>
}

function auditDetailText(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return ''
  const values = metadata as Record<string, unknown>
  const details: string[] = []
  if (Array.isArray(values.changed_fields)) {
    const fields = values.changed_fields.filter((field): field is string => typeof field === 'string')
    if (fields.length > 0) details.push(`Changed: ${fields.map((field) => field.replaceAll('_', ' ')).join(', ')}`)
  }
  if (typeof values.clinical_profile_version === 'number') details.push(`Clinical profile version ${values.clinical_profile_version}`)
  for (const [oldKey, newKey, label] of [
    ['old_status', 'new_status', 'Status'],
    ['old_role', 'new_role', 'Role'],
    ['old_currency', 'new_currency', 'Currency'],
    ['old_is_active', 'new_is_active', 'Active'],
  ]) {
    const oldValue = values[oldKey]
    const newValue = values[newKey]
    if ((typeof oldValue === 'string' || typeof oldValue === 'boolean') && (typeof newValue === 'string' || typeof newValue === 'boolean')) {
      details.push(`${label}: ${String(oldValue)} → ${String(newValue)}`)
    }
  }
  if (typeof values.new_status === 'string' && !('old_status' in values)) details.push(`Status: ${values.new_status}`)
  if (typeof values.role === 'string') details.push(`Role: ${values.role}`)
  if (typeof values.amount === 'number') details.push(`Amount: ${values.amount}${typeof values.currency === 'string' ? ` ${values.currency}` : ''}`)
  if (typeof values.payment_method === 'string') details.push(`Method: ${values.payment_method.replaceAll('_', ' ')}`)
  if (typeof values.tooth_number === 'number') details.push(`Tooth ${values.tooth_number}`)
  if (typeof values.entry_type === 'string') details.push(values.entry_type.replaceAll('_', ' '))
  if (Array.isArray(values.surfaces)) {
    const surfaces = values.surfaces.filter((surface): surface is string => typeof surface === 'string')
    if (surfaces.length > 0) details.push(surfaces.map((surface) => surface.replaceAll('_', ' ')).join(', '))
  }
  if (typeof values.is_active === 'boolean') details.push(values.is_active ? 'Active' : 'Inactive')
  return details.join(' · ')
}

function auditActionSentence(event: AuditLog) {
  if (['visit_amended','prescription_withdrawn','prescription_replaced','investigation_withdrawn','investigation_replaced','procedure_withdrawn','dental_entry_withdrawn'].includes(event.action ?? '')) return (event.action ?? '').replaceAll('_',' ')
  if (event.action === 'procedure_recorded') return 'recorded a performed procedure'
  if (event.action === 'procedure_corrected') return 'corrected a performed procedure'
  if (event.action === 'catalog_procedure_created') return 'added a catalog procedure'
  if (event.action === 'catalog_procedure_activated') return 'activated a catalog procedure'
  if (event.action === 'catalog_procedure_deactivated') return 'deactivated a catalog procedure'
  if (event.action === 'corrected' && event.table_name === 'dental_chart_entries') return 'corrected an odontogram entry'
  if (event.action === 'finalized' && event.table_name === 'standalone_visit_lifecycle') return 'finalized a standalone visit'
  if (event.action === 'currency_changed') return 'changed clinic currency'
  if (event.action === 'status_changed') return 'changed appointment status'
  if (event.action === 'consultation_updated') return 'updated a consultation'
  if (event.action === 'role_changed') return 'changed a staff role'
  if (event.action === 'activated') return 'activated a staff member'
  if (event.action === 'deactivated') return 'deactivated a staff member'
  if (event.action === 'staff_updated') return 'updated a staff member'
  if (event.action === 'provisioned') return 'added a staff member'
  if (event.action === 'recorded') return 'recorded a payment'
  if (event.action === 'created' && event.table_name === 'patients') return 'registered a patient'
  if (event.action === 'created' && event.table_name === 'appointments') return 'booked an appointment'
  if (event.action === 'created' && event.table_name === 'visits') return 'created a visit'
  if (event.action === 'created' && event.table_name === 'prescriptions') return 'added a prescription'
  if (event.action === 'created' && event.table_name === 'investigations') return 'added an investigation'
  if (event.action === 'created' && event.table_name === 'dental_chart_entries') return 'added an odontogram entry'
  if (event.action === 'created' && event.table_name === 'invoices') return 'created an invoice'
  if (event.action === 'created' && event.table_name === 'clinics') return 'created the clinic'
  return `${(event.action ?? 'updated').replaceAll('_', ' ')} ${event.table_name?.replaceAll('_', ' ') ?? 'record'}`
}

function AuditActivityView({ clinicId, clinicName }: { clinicId: string; clinicName: string }) {
  const [events, setEvents] = useState<AuditLog[]>([])
  const [actorNames, setActorNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [selectedActor, setSelectedActor] = useState('')
  const [selectedKind, setSelectedKind] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function loadActivity() {
      if (!supabase) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }
      setLoading(true)
      const { data, error: queryError } = await supabase
        .from('audit_logs')
        .select('id, clinic_id, actor_user_id, table_name, record_id, action, metadata, created_at')
        .eq('clinic_id', clinicId)
        .order('created_at', { ascending: false })
        .limit(250)
      if (cancelled) return
      if (queryError) {
        setLoading(false)
        setError('We could not load clinic activity.')
        return
      }

      const rows = (data ?? []) as AuditLog[]
      const actorIds = [...new Set(rows.map((row) => row.actor_user_id).filter((id): id is string => Boolean(id)))]
      let names: Record<string, string> = {}
      if (actorIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, display_name')
          .in('id', actorIds)
        names = Object.fromEntries(((profiles ?? []) as Array<{ id: string; display_name: string | null }>).map((profile) => [profile.id, profile.display_name?.trim() || profile.id]))
      }
      if (cancelled) return
      setEvents(rows)
      setActorNames(names)
      setError(null)
      setLoading(false)
    }

    void loadActivity()
    return () => { cancelled = true }
  }, [clinicId, refreshVersion])

  const kinds = [...new Set(events.map((event) => `${event.table_name ?? ''}|${event.action ?? ''}`))]
  const actors = [...new Set(events.map((event) => event.actor_user_id).filter((id): id is string => Boolean(id)))]
  const visibleEvents = events.filter((event) =>
    (!selectedDate || event.created_at.slice(0, 10) === selectedDate)
    && (!selectedActor || event.actor_user_id === selectedActor)
    && (!selectedKind || `${event.table_name ?? ''}|${event.action ?? ''}` === selectedKind),
  )

  return <div className="patients-page activity-page">
    <div className="page-heading"><div><p className="eyebrow">Clinic accountability</p><h1>Audit / Activity</h1><p className="panel-copy">Activity history is available from the date auditing was enabled.</p></div><button className="button-secondary" onClick={() => setRefreshVersion((version) => version + 1)} type="button">Refresh</button></div>
    <div className="activity-filters" aria-label="Activity filters">
      <label>Date<input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
      <label>Actor<select value={selectedActor} onChange={(event) => setSelectedActor(event.target.value)}><option value="">All actors</option>{actors.map((actorId) => <option key={actorId} value={actorId}>{actorNames[actorId] ?? actorId}</option>)}</select></label>
      <label>Action / entity<select value={selectedKind} onChange={(event) => setSelectedKind(event.target.value)}><option value="">All activity</option>{kinds.map((kind) => {
        const [tableName, action] = kind.split('|')
        return <option key={kind} value={kind}>{`${tableName.replaceAll('_', ' ')} · ${action.replaceAll('_', ' ')}`}</option>
      })}</select></label>
    </div>
    {loading && <SoapSmileLoadingState>Loading activity...</SoapSmileLoadingState>}
    {!loading && error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    {!loading && !error && visibleEvents.length === 0 && <SoapSmileEmptyState icon="activity"><p>No activity matches these filters.</p></SoapSmileEmptyState>}
    {!loading && !error && visibleEvents.length > 0 && <div className="activity-list" tabIndex={0} role="region" aria-label="Activity log">{visibleEvents.map((event) => {
      const details = auditDetailText(event.metadata)
      const actorName = event.actor_user_id ? actorNames[event.actor_user_id] ?? event.actor_user_id : 'Unknown user'
      return <article className="activity-entry" key={event.id}>
        <div className="activity-entry-heading"><strong>{actorName} {auditActionSentence(event)}</strong><time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time></div>
        {details && <p className="activity-details">{details}</p>}
        <p className="activity-actor">{clinicName} · {(event.table_name ?? 'record').replaceAll('_', ' ')}{event.record_id ? ` · ${event.record_id}` : ''}</p>
      </article>
    })}</div>}
  </div>
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

function DashboardView({ clinicId, clinicName, timezone, role, userId, onOpenPatients, onOpenBilling, onOpenAppointments }: { clinicId: string; clinicName: string; timezone: string; role: UserRole; userId: string; onOpenPatients: () => void; onOpenBilling: () => void; onOpenAppointments: () => void }) {
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
      let recentPayments: DashboardPayment[] = []
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

        const todayPayments = (todayPaymentResult.data ?? []) as DashboardPayment[]
        recentPayments = (recentPaymentResult.data ?? []) as DashboardPayment[]
        const openInvoices = (openInvoiceResult.data ?? []) as DashboardInvoice[]
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
  const waitingAppointments = appointments.filter((appointment) => appointment.status === 'arrived' || appointment.status === 'waiting')
  const inProgressAppointments = appointments.filter((appointment) => appointment.status === 'in_progress')
  const completedAppointments = appointments.filter((appointment) => appointment.status === 'completed')
  const currencyTotals = (totals: Record<string, number>) => Object.entries(totals).sort(([first], [second]) => first.localeCompare(second)).map(([currency, amount]) => <span key={currency}>{formatMoney(amount, currency)}</span>)
  const flowSummary = [
    { label: 'Appointments', value: appointments.length, icon: 'appointments' as const },
    { label: 'Waiting', value: new Set(waitingAppointments.map((appointment) => appointment.patient_id)).size, icon: 'activity' as const },
    { label: 'In consultation', value: inProgressAppointments.length, icon: 'clinical' as const },
    { label: 'Completed', value: completedAppointments.length, icon: 'check' as const },
  ]
  const patientName = (patientId: string) => {
    const patient = data?.patients[patientId]
    return patient ? `${[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} · ${patient.patient_number}` : 'Patient details unavailable'
  }

  const recentPayments = (data?.recentPayments ?? []).slice(0, 5)

  return (
    <div className="dashboard-page">
      <div className="dashboard-intro"><div><p className="eyebrow">Clinic operations · {today}</p><h1>{clinicName}</h1><p className="panel-copy">Today’s schedule and workload.</p></div><button className="primary-action" onClick={onOpenPatients} type="button">Open patient list</button></div>
      {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
      {loading && <SoapSmileLoadingState>Loading dashboard...</SoapSmileLoadingState>}
      {!loading && !error && data && <>
        <div className={`dashboard-overview${canViewFinance ? '' : ' dashboard-overview-clinical-only'}`}>
          <section className="dashboard-flow-panel">
            <div className="dashboard-overview-heading"><div><p className="eyebrow">{role === 'doctor' ? 'Assigned workload' : 'Clinic flow'}</p><h2>Dental Operations Core</h2></div><span className="dashboard-date-label">{today}</span></div>
            <SoapSmileOperationsCore metrics={flowSummary} personal={role === 'doctor'} />
          </section>
          {canViewFinance && <aside className="dashboard-finance-panel">
            <div className="dashboard-overview-heading"><div><p className="eyebrow">Clinic snapshot</p><h2>Finance & reach</h2></div><span className="finance-lockup"><SoapSmileIcon name="billing" /></span></div>
            <div className="dashboard-finance-row"><span>Total patients</span><strong>{data.patientCount ?? 0}</strong></div>
            <div className="dashboard-finance-row"><span>Payments today</span><strong>{Object.keys(data.revenueByCurrency).length > 0 ? currencyTotals(data.revenueByCurrency) : 'None recorded'}</strong></div>
            <div className="dashboard-finance-row"><span>Outstanding</span><strong>{Object.keys(data.outstandingByCurrency).length > 0 ? currencyTotals(data.outstandingByCurrency) : 'No open balance'}</strong></div>
          </aside>}
        </div>
        <div className="dashboard-sections">
          <DashboardSection title="Today's Schedule" actionLabel="View all" onAction={onOpenAppointments}>
            {appointments.length === 0 ? <SoapSmileEmptyState><p>No appointments scheduled today.</p></SoapSmileEmptyState> : <div className="dashboard-row-list">{appointments.slice(0, 5).map((appointment) => <div className="dashboard-row" key={appointment.id}><span>{formatTime(appointment.start_time)}</span><strong>{patientName(appointment.patient_id)}</strong><span className={`appointment-status status-${appointment.status}`}>{formatStatus(appointment.status)}</span>{appointment.service && <small>{appointment.service}</small>}</div>)}</div>}
          </DashboardSection>
          <DashboardSection title="Waiting Queue" actionLabel="View all" onAction={onOpenAppointments}>
            {waitingAppointments.length === 0 ? <SoapSmileEmptyState><p>No patients waiting.</p></SoapSmileEmptyState> : <div className="dashboard-row-list">{waitingAppointments.slice(0, 5).map((appointment) => <div className="dashboard-row" key={appointment.id}><span>{formatTime(appointment.start_time)}</span><strong>{patientName(appointment.patient_id)}</strong>{appointment.service && <small>{appointment.service}</small>}</div>)}</div>}
          </DashboardSection>
          {canViewFinance && <DashboardSection title="Recent Payments" actionLabel="View all" onAction={onOpenBilling}>
            {recentPayments.length === 0 ? <SoapSmileEmptyState><p>No payments recorded yet.</p></SoapSmileEmptyState> : <div className="dashboard-row-list">{recentPayments.map((payment) => {
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
  const iconName = label.toLowerCase().includes('patient') ? 'patients'
    : label.toLowerCase().includes('appointment') ? 'appointments'
      : label.toLowerCase().includes('waiting') ? 'activity'
        : label.toLowerCase().includes('consultation') || label.toLowerCase().includes('visit') ? 'clinical'
          : label.toLowerCase().includes('payment') || label.toLowerCase().includes('balance') ? 'billing'
            : 'staff'
  return <section className="summary-card"><div className="metric-heading"><p className="card-label">{label}</p><span className="metric-icon"><SoapSmileIcon name={iconName} /></span></div><p className="card-value">{value}</p></section>
}

function DashboardSection({ title, children, actionLabel, onAction }: { title: string; children: React.ReactNode; actionLabel?: string; onAction?: () => void }) {
  return <section className="dashboard-list-section"><div className="section-heading"><h3>{title}</h3>{actionLabel && onAction ? <button className="section-link" onClick={onAction} type="button">{actionLabel} <span aria-hidden="true">→</span></button> : null}</div>{children}</section>
}

const managedStaffRoles: ClinicMembership['role'][] = ['admin', 'doctor', 'receptionist']
type InvitableStaffRole = Extract<ClinicMembership['role'], 'admin' | 'doctor' | 'receptionist'>

function StaffManagementView({ clinicId, userId }: { clinicId: string; userId: string }) {
  const [staff, setStaff] = useState<ClinicMembership[]>([])
  const [profiles, setProfiles] = useState<Record<string, string | null>>({})
  const [roleChanges, setRoleChanges] = useState<Record<string, ClinicMembership['role']>>({})
  const [loading, setLoading] = useState(true)
  const [savingUserId, setSavingUserId] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteDisplayName, setInviteDisplayName] = useState('')
  const [inviteRole, setInviteRole] = useState<InvitableStaffRole | ''>('')
  const [inviting, setInviting] = useState(false)
  const inviteInFlight = useRef(false)
  useEffect(() => {
    let cancelled = false

    async function loadStaff() {
      if (!supabase) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }

      setLoading(true)
      setError(null)
      const { data: membershipRows, error: membershipError } = await supabase
        .from('clinic_memberships')
        .select('user_id, clinic_id, role, is_active, created_at')
        .eq('clinic_id', clinicId)
        .in('role', managedStaffRoles)
        .order('created_at', { ascending: true })
      if (cancelled) return
      if (membershipError) {
        setLoading(false)
        setError('We could not load staff for this clinic.')
        return
      }

      const memberships = (membershipRows ?? []) as ClinicMembership[]
      const userIds = memberships.map((membership) => membership.user_id)
      let profileMap: Record<string, string | null> = {}
      if (userIds.length > 0) {
        const { data: profileRows, error: profileError } = await supabase
          .from('profiles')
          .select('id, display_name')
          .in('id', userIds)
        if (cancelled) return
        if (profileError) {
          setLoading(false)
          setError('We could not load staff display names.')
          return
        }
        profileMap = Object.fromEntries(((profileRows ?? []) as Array<{ id: string; display_name: string | null }>).map((profile) => [profile.id, profile.display_name]))
      }

      setStaff(memberships)
      setProfiles(profileMap)
      setRoleChanges({})
      setLoading(false)
    }

    void loadStaff()
    return () => { cancelled = true }
  }, [clinicId, refreshVersion])

  async function changeRole(membership: ClinicMembership) {
    const newRole = roleChanges[membership.user_id] ?? membership.role
    if (newRole === membership.role || !supabase) return
    setSavingUserId(membership.user_id)
    setError(null)
    setSuccess(null)
    const { data, error: rpcError } = await supabase.rpc('admin_change_clinic_staff_role', {
      p_clinic_id: clinicId,
      p_target_user_id: membership.user_id,
      p_new_role: newRole,
    } as never)
    setSavingUserId(null)
    if (rpcError || !data) {
      setError(rpcError?.message || 'We could not update this staff role. No change was made.')
      return
    }
    setSuccess('Staff role updated.')
    setRefreshVersion((version) => version + 1)
  }

  async function setStaffActive(membership: ClinicMembership) {
    const name = profiles[membership.user_id]?.trim() || 'this staff member'
    if (membership.is_active && !window.confirm(`Deactivate ${name}? They will lose access to this clinic.`)) return
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }

    setSavingUserId(membership.user_id)
    setError(null)
    setSuccess(null)
    const { data, error: rpcError } = await supabase.rpc('admin_set_clinic_staff_active', {
      p_clinic_id: clinicId,
      p_target_user_id: membership.user_id,
      p_is_active: !membership.is_active,
    } as never)
    setSavingUserId(null)
    if (rpcError || !data) {
      setError(rpcError?.message || 'We could not update this staff membership. No change was made.')
      return
    }
    setSuccess(membership.is_active ? 'Staff member deactivated.' : 'Staff member activated.')
    setRefreshVersion((version) => version + 1)
  }

  async function inviteStaff(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inviteInFlight.current) return

    const email = inviteEmail.trim().toLowerCase()
    const displayName = inviteDisplayName.trim()
    if (!email || !displayName || !inviteRole) {
      setError('Enter an email, display name, and role.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }

    inviteInFlight.current = true
    setInviting(true)
    setError(null)
    setSuccess(null)
    try {
      const { data, error: inviteError } = await supabase.functions.invoke('invite-staff', {
        body: {
          clinic_id: clinicId,
          email,
          display_name: displayName,
          role: inviteRole,
        },
      })
      if (inviteError) {
        let message = 'We could not send this invitation. Please try again.'
        if (typeof inviteError === 'object' && 'context' in inviteError && inviteError.context instanceof Response) {
          try {
            const responseBody = await inviteError.context.clone().json() as { error?: unknown }
            if (typeof responseBody.error === 'string') message = responseBody.error
          } catch {
            // Keep the generic message if the function returned a non-JSON error.
          }
        }
        setError(message)
        return
      }

      setSuccess(data && typeof data.message === 'string' ? data.message : 'Invitation sent and staff member added.')
      setInviteEmail('')
      setInviteDisplayName('')
      setInviteRole('')
      setRefreshVersion((version) => version + 1)
    } catch {
      setError('We could not send this invitation. Please try again.')
    } finally {
      inviteInFlight.current = false
      setInviting(false)
    }
  }

  return <div className="staff-page">
    <div className="page-heading"><div><p className="eyebrow">Clinic management</p><h1>Staff</h1><p className="panel-copy">Manage active clinic staff and roles.</p></div></div>
    <section className="registration-panel staff-invite-panel">
      <div className="registration-heading"><p className="eyebrow">Staff access</p><h2>Invite Staff</h2></div>
      <form className="staff-invite-form" onSubmit={(event) => void inviteStaff(event)}>
        <label>Email<input type="email" autoComplete="email" maxLength={254} value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required /></label>
        <label>Display Name<input autoComplete="name" maxLength={120} value={inviteDisplayName} onChange={(event) => setInviteDisplayName(event.target.value)} required /></label>
        <label>Role<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as InvitableStaffRole | '')} required><option value="">Select role</option><option value="doctor">Doctor</option><option value="receptionist">Receptionist</option><option value="admin">Admin</option></select></label>
        <button className="primary-action" type="submit" disabled={inviting}>{inviting ? <><SoapSmileLoader size="button" />Sending...</> : 'Send Invitation'}</button>
      </form>
    </section>
    {success && <SoapSmileFeedback tone="success">{success}</SoapSmileFeedback>}
    {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    {loading && <SoapSmileLoadingState>Loading staff...</SoapSmileLoadingState>}
    {!loading && !error && staff.length === 0 && <SoapSmileEmptyState icon="staff"><h2>No staff memberships</h2><p>Staff assigned to this clinic will appear here.</p></SoapSmileEmptyState>}
    {!loading && !error && staff.length > 0 && <div className="table-frame staff-table-frame" tabIndex={0} role="region" aria-label="Staff directory"><table className="patient-table staff-table"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>{staff.map((membership) => {
      const name = profiles[membership.user_id]?.trim() || 'Unnamed staff'
      const isCurrentAdmin = membership.user_id === userId
      const selectedRole = roleChanges[membership.user_id] ?? membership.role
      const isSaving = savingUserId === membership.user_id
      return <tr key={membership.user_id}><td className="staff-name">{name}{isCurrentAdmin && <span className="staff-you">You</span>}</td><td><span className="staff-role-badge">{formatStatus(membership.role)}</span></td><td><span className={`staff-status${membership.is_active ? ' active' : ' inactive'}`}>{membership.is_active ? 'Active' : 'Inactive'}</span></td><td>{isCurrentAdmin ? <span className="staff-self-note">Your access is managed separately.</span> : <div className="staff-actions"><label className="staff-role-select"><span className="visually-hidden">Role for {name}</span><select aria-label={`Role for ${name}`} value={selectedRole} onChange={(event) => setRoleChanges((current) => ({ ...current, [membership.user_id]: event.target.value as ClinicMembership['role'] }))} disabled={isSaving}><option value="admin">Admin</option><option value="doctor">Doctor</option><option value="receptionist">Receptionist</option></select></label><button className="button-secondary staff-action" onClick={() => void changeRole(membership)} type="button" disabled={isSaving || selectedRole === membership.role}>{isSaving ? <><SoapSmileCompanion state="saving" />Saving...</> : 'Save role'}</button><button className="button-secondary staff-action" onClick={() => void setStaffActive(membership)} type="button" disabled={isSaving}>{membership.is_active ? 'Deactivate' : 'Activate'}</button></div>}</td></tr>
    })}</tbody></table></div>}
  </div>
}

type ReportsData = {
  procedureActivity: ProcedureActivity
  registrations: number
  appointments: DashboardAppointment[]
  visits: ReportVisit[]
  paymentsByCurrency: Record<string, number>
  paymentsByMethod: Record<string, Record<string, number>>
  outstandingByCurrency: Record<string, number>
  doctorActivity: Array<{ id: string; label: string; appointments: number; visits: number }>
}

function ClinicalVisitsView({ clinicId, onPrintVisitSummary, onViewPatient, onOpenPatients }: { clinicId: string; onPrintVisitSummary: PrintVisitSummary; onViewPatient: (patient: Patient) => void; onOpenPatients: () => void }) {
  const [visits, setVisits] = useState<Visit[]>([])
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([])
  const [investigations, setInvestigations] = useState<Investigation[]>([])
  const [recordContext, setRecordContext] = useState<ClinicalRecordContext | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedPatientId, setSelectedPatientId] = useState('')
  const [recordPage,setRecordPage] = useState(1)
  const [hasOlder,setHasOlder] = useState(false)
  const correctionState = useCorrections(clinicId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadClinicalVisits() {
      const client = supabase
      if (!client) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }

      setLoading(true)
      setError(null)
      const { data: visitData, error: visitError } = await client.from('visits').select('*').eq('clinic_id',clinicId).order('visit_date',{ascending:false}).order('id').range((recordPage-1)*100,recordPage*100-1)
      if (cancelled) return
      setHasOlder((visitData ?? []).length===100)
      if (visitError) {
        setLoading(false)
        setError('We could not load this clinic\'s clinical visits.')
        return
      }

      const visitRows = (visitData ?? []) as Visit[]
      if (visitRows.length === 0) {
        setVisits([])
        setPrescriptions([])
        setInvestigations([])
        setRecordContext(null)
        setLoading(false)
        return
      }

      const visitIds = visitRows.map((visit) => visit.id)
      const [prescriptionResult, investigationResult] = await Promise.all([
        pagedResult(() => client.from('prescriptions').select('*').eq('clinic_id', clinicId).in('visit_id', visitIds).order('id')),
        pagedResult(() => client.from('investigations').select('*').eq('clinic_id', clinicId).in('visit_id', visitIds).order('id')),
      ])
      if (cancelled) return
      if (prescriptionResult.error || investigationResult.error) {
        setLoading(false)
        setError('We could not load this clinic\'s visit records.')
        return
      }

      const context = await loadClinicalRecordContext(clinicId, visitRows.map((visit) => ({
        patient_id: visit.patient_id,
        visit_id: visit.id,
        doctor_id: visit.doctor_id,
      })))
      if (cancelled) return
      if (!context) {
        setLoading(false)
        setError('We could not load linked patient and clinician details.')
        return
      }
      setVisits(visitRows)
      setPrescriptions((prescriptionResult.data ?? []) as Prescription[])
      setInvestigations((investigationResult.data ?? []) as Investigation[])
      setRecordContext(context)
      setLoading(false)
    }

    void loadClinicalVisits()
    return () => { cancelled = true }
  }, [clinicId,recordPage])

  const patientVisitSummary = new Map<string, { patient: Patient; visitCount: number; latestVisit: string }>()
  for (const originalVisit of visits) {
    const visit=effectiveRecord(originalVisit,correctionState.rows,'visit')!
      const patient = recordContext?.patients[visit.patient_id]
    if (!patient) continue
    const summary = patientVisitSummary.get(patient.id)
    if (summary) summary.visitCount += 1
    else patientVisitSummary.set(patient.id, { patient, visitCount: 1, latestVisit: visit.visit_date })
  }
  const clinicalPatients = [...patientVisitSummary.values()].sort((first, second) => second.latestVisit.localeCompare(first.latestVisit))
  const normalizedSearch = searchTerm.trim().toLowerCase()
  const matchingPatients = clinicalPatients.filter(({ patient }) =>
    !normalizedSearch || [patient.patient_number, patient.first_name, patient.middle_name, patient.last_name, patient.phone]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalizedSearch)),
  )
  const selectedPatient = clinicalPatients.find(({ patient }) => patient.id === selectedPatientId)?.patient ?? null
  const selectedPatientVisits = selectedPatient ? visits.filter((visit) => visit.patient_id === selectedPatient.id) : []
  const visibleVisits = visits.filter((visit) => {
    if (selectedPatientId && visit.patient_id !== selectedPatientId) return false
    if (!normalizedSearch) return true
    const patient = recordContext?.patients[visit.patient_id]
    return Boolean(patient && [patient.patient_number, patient.first_name, patient.middle_name, patient.last_name, patient.phone]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalizedSearch)))
  })
  const [visitPage, setVisitPage] = useState(1)
  const visitPageSize = 5
  const visitPageCount = Math.max(1, Math.ceil(visibleVisits.length / visitPageSize))
  const effectiveVisitPage = Math.max(1, Math.min(visitPage, visitPageCount))
  const paginatedVisits = visibleVisits.slice((effectiveVisitPage - 1) * visitPageSize, effectiveVisitPage * visitPageSize)

  return <div className="patients-page"><div className="form-actions"><button type="button" className="button-secondary" disabled={loading || recordPage===1} onClick={() => setRecordPage(recordPage-1)}>Newer records</button><span>History page {recordPage}</span><button type="button" className="button-secondary" disabled={loading || !hasOlder} onClick={() => setRecordPage(recordPage+1)}>Older records</button></div>{correctionState.error && <p role="alert">{correctionState.error}</p>}
    <div className="page-heading clinical-page-heading"><div><p className="eyebrow">Clinical records</p><h1>Clinical Visits</h1><p className="panel-copy">Patient history and recent encounters.</p></div><button className="button-secondary clinical-directory-action" onClick={onOpenPatients} type="button"><SoapSmileIcon name="patients" />Patient directory</button></div>
    {loading && <SoapSmileLoadingState>Loading clinical visits...</SoapSmileLoadingState>}
    {!loading && error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    {!loading && !error && !correctionState.loading && !correctionState.error && visits.length === 0 && <SoapSmileEmptyState><h2>No clinical visits recorded</h2></SoapSmileEmptyState>}
    {!loading && !error && !correctionState.loading && !correctionState.error && visits.length > 0 && <>
      <section className="clinical-summary-strip" aria-label="Clinical visit summary">
        <div className="clinical-summary-identity"><span className="summary-overline">{selectedPatient ? 'SELECTED PATIENT' : 'CLINIC HISTORY'}</span><strong>{selectedPatient ? [selectedPatient.first_name, selectedPatient.middle_name, selectedPatient.last_name].filter(Boolean).join(' ') : 'Clinical overview'}</strong><span>{selectedPatient ? `File ${selectedPatient.patient_number} · ${formatPatientAge(selectedPatient)}` : `${clinicalPatients.length} patients with visit history`}</span></div>
        <div className="clinical-summary-stat"><span>Visits</span><strong>{selectedPatient ? selectedPatientVisits.length : visits.length}</strong></div>
        <div className="clinical-summary-stat"><span>Latest encounter</span><strong>{formatDateTime(selectedPatient ? selectedPatientVisits[0]?.visit_date : visits[0]?.visit_date)}</strong></div>
        {selectedPatient && <button className="button-secondary clinical-open-patient" onClick={() => onViewPatient(selectedPatient)} type="button"><SoapSmileIcon name="patient-file" />Open patient file</button>}
      </section>
      <div className="clinical-workspace">
        <aside className="clinical-patient-panel">
          <div className="clinical-panel-heading"><div><p className="eyebrow">Patient retrieval</p><h2>Patients with visits</h2></div><span>{matchingPatients.length}</span></div>
          <PatientSearchField label="Filter this history page (use Patient directory for full search)" value={searchTerm} onChange={setSearchTerm} placeholder="Name, file number, or phone" />
          {matchingPatients.length === 0 ? <p className="clinical-search-empty">No patients match this search.</p> : <div className="clinical-patient-results" tabIndex={0} role="region" aria-label="Patients with clinical visits">{matchingPatients.map(({ patient, visitCount }) => <button className={`clinical-patient-result${selectedPatientId === patient.id ? ' selected' : ''}`} key={patient.id} type="button" aria-pressed={selectedPatientId === patient.id} onClick={() => setSelectedPatientId((current) => current === patient.id ? '' : patient.id)}>
            <span className="clinical-patient-avatar">{patient.first_name[0]}{patient.last_name[0]}</span><span className="clinical-patient-copy"><strong>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</strong><small>{patient.patient_number} · {formatPatientAge(patient)}</small></span><span className="clinical-visit-count">{visitCount}</span>
          </button>)}</div>}
        </aside>
        <section className="clinical-visit-panel" aria-label="Visit history">
          <div className="clinical-panel-heading"><div><p className="eyebrow">Chronological record</p><h2>{selectedPatient ? 'Patient visits' : 'Recent visits'}</h2></div><span>{visibleVisits.length} {visibleVisits.length === 1 ? 'visit' : 'visits'}</span></div>
          {visibleVisits.length === 0 ? <div className="clinical-visit-empty"><SoapSmileIcon name="history" /><p>No visits match this patient search.</p></div> : <>
            <div className="clinical-visit-list" tabIndex={0} role="region" aria-label="Clinical visit list">{paginatedVisits.map((originalVisit) => {
              const visit=effectiveRecord(originalVisit,correctionState.rows,'visit')!
              const patient = recordContext?.patients[visit.patient_id]
              const clinicianName = recordContext?.doctorNames[visit.doctor_id] ?? 'Clinic doctor'
              const visitPrescriptions = prescriptions.filter((prescription) => prescription.visit_id === visit.id).map((row) => effectiveRecord(row,correctionState.rows,'prescription')).filter((row): row is Prescription => Boolean(row))
              const visitInvestigations = investigations.filter((investigation) => investigation.visit_id === visit.id).map((row) => effectiveRecord(row,correctionState.rows,'investigation')).filter((row): row is Investigation => Boolean(row))
              const preview = visit.chief_complaint || visit.assessment || visit.treatment_plan
              return <article className="clinical-visit-row" key={visit.id}>
                <div className="clinical-visit-date"><SoapSmileIcon name="calendar" /><time dateTime={visit.visit_date}>{formatDateTime(visit.visit_date)}</time></div>
                <div className="clinical-visit-details"><strong>{patient ? [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ') : 'Patient unavailable'}</strong><span>{patient?.patient_number ?? 'File unavailable'} · {clinicianName}</span>{preview && <p>{preview}</p>}<small>{visitPrescriptions.length} {visitPrescriptions.length === 1 ? 'prescription' : 'prescriptions'} · {visitInvestigations.length} {visitInvestigations.length === 1 ? 'investigation' : 'investigations'}</small></div>
                <div className="clinical-visit-actions">{patient && <button className="button-secondary inline-button" onClick={() => onViewPatient(patient)} type="button"><SoapSmileIcon name="patient-file" />Patient file</button>}{patient && <button className="button-secondary inline-button" onClick={() => onPrintVisitSummary(patient, visit, clinicianName, visitPrescriptions, visitInvestigations)} type="button"><SoapSmileIcon name="print" />Print summary</button>}</div>
              </article>
            })}</div>
            {visitPageCount > 1 && <div className="compact-pagination" aria-label="Clinical visit pagination"><button type="button" disabled={effectiveVisitPage === 1} onClick={() => setVisitPage(Math.max(1, effectiveVisitPage - 1))}>Previous</button><span>{effectiveVisitPage} / {visitPageCount}</span><button type="button" disabled={effectiveVisitPage === visitPageCount} onClick={() => setVisitPage(Math.min(visitPageCount, effectiveVisitPage + 1))}>Next</button></div>}
          </>}
        </section>
      </div>
    </>}
  </div>
}

function ReportsView({ clinicId, timezone, onPrintReport }: { clinicId: string; timezone: string; onPrintReport: PrintReport }) {
  const today = getClinicLocalDate(new Date(), timezone)
  const [startDate, setStartDate] = useState(`${today.slice(0, 7)}-01`)
  const [endDate, setEndDate] = useState(today)
  const [data, setData] = useState<ReportsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ReportView>('overview')
  const [refreshVersion, setRefreshVersion] = useState(0)
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
      const [registrationResult, appointmentResult, visitResult, paymentResult, invoiceResult, procedureResult] = await Promise.all([
        supabase.from('patients').select('id', { count: 'exact', head: true }).eq('clinic_id', clinicId).gte('created_at', bounds.start).lt('created_at', bounds.end),
        supabase.from('appointments').select('id, patient_id, doctor_id, appointment_date, start_time, end_time, service, status').eq('clinic_id', clinicId).gte('appointment_date', effectiveStart).lte('appointment_date', effectiveEnd).order('appointment_date', { ascending: true }).order('start_time', { ascending: true }),
        supabase.from('visits').select('id, doctor_id, appointment_id').eq('clinic_id', clinicId).gte('visit_date', bounds.start).lt('visit_date', bounds.end),
        supabase.from('payments').select('id, clinic_id, invoice_id, patient_id, amount, payment_method, payment_date').eq('clinic_id', clinicId).gte('payment_date', bounds.start).lt('payment_date', bounds.end),
        supabase.from('invoices').select('id, currency, status, balance').eq('clinic_id', clinicId).in('status', ['draft', 'partially_paid']).gt('balance', 0),
        procedureClient!.rpc('procedure_activity_report', { p_clinic_id: clinicId, p_start_date: effectiveStart, p_end_date: effectiveEnd }),
      ])
      if (cancelled) return
      if (registrationResult.error || appointmentResult.error || visitResult.error || paymentResult.error || invoiceResult.error || procedureResult.error || !procedureResult.data) {
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
      const doctorIds = [...new Set([...appointments.map((appointment) => appointment.doctor_id), ...visits.map((visit) => visit.doctor_id)].filter((id): id is string => Boolean(id)))]
      const doctorLabels = await loadClinicianNames(doctorIds)
      if (cancelled) return
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
        procedureActivity: procedureResult.data!,
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
  }, [clinicId, effectiveEnd, effectiveStart, timezone, refreshVersion])

  const appointmentsByStatus = (data?.appointments ?? []).reduce<Record<string, number>>((counts, appointment) => {
    counts[appointment.status] = (counts[appointment.status] ?? 0) + 1
    return counts
  }, {})
  const totals = (values: Record<string, number>) => Object.entries(values).sort(([first], [second]) => first.localeCompare(second)).map(([currency, amount]) => <span key={currency}>{formatMoney(amount, currency)}</span>)

  return <div className="reports-page">
    <div className="page-heading"><div><p className="eyebrow">Clinic operations</p><h1>Reports</h1><p className="panel-copy">Period activity and current balances.</p></div>{!loading && !error && data && <button className="primary-action" onClick={() => onPrintReport(data, effectiveStart, effectiveEnd, view)} type="button">Print Report</button>}</div>
    <div className="report-date-range"><label>From<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label>Through<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label><button type="button" className="button-secondary" disabled={loading} onClick={() => setRefreshVersion((value) => value + 1)}>Refresh</button></div>
    <div className="appointment-tabs report-tabs" role="tablist" aria-label="Report views">{([['overview', 'Overview'], ['procedures', 'Procedure Activity']] as const).map(([key, label]) => <button type="button" key={key} role="tab" id={'report-tab-' + key} aria-controls={'report-view-' + key} aria-selected={view === key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>{label}</button>)}</div>
    {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    {loading && <SoapSmileLoadingState>Loading reports...</SoapSmileLoadingState>}
    {!loading && !error && data && <>
      {view === 'procedures' ? <div id="report-view-procedures" role="tabpanel" aria-labelledby="report-tab-procedures"><p className="report-period">{formatDate(effectiveStart)} – {formatDate(effectiveEnd)}</p><ProcedureActivitySummary data={data.procedureActivity} /></div> : <section id="report-view-overview" role="tabpanel" aria-labelledby="report-tab-overview"><div className="report-view-heading"><h2>Overview</h2><p className="report-period">{formatDate(effectiveStart)} – {formatDate(effectiveEnd)}</p></div>
      <div className="summary-grid report-metrics">
        <DashboardMetric label="Patient Registrations" value={String(data.registrations)} />
        <DashboardMetric label="Appointments" value={String(data.appointments.length)} />
        <DashboardMetric label="Visits / Consultations" value={String(data.visits.length)} />
        <DashboardMetric label="Payments Received" value={totals(data.paymentsByCurrency)} />
      </div>
      <div className="report-grid">
        <DashboardSection title="Appointment Status">
          {Object.keys(appointmentsByStatus).length === 0 ? <SoapSmileEmptyState icon="reports"><p>No appointments in this period.</p></SoapSmileEmptyState> : <div className="report-value-list">{Object.entries(appointmentsByStatus).map(([status, count]) => <div key={status}><span>{formatStatus(status)}</span><strong>{count}</strong></div>)}</div>}
        </DashboardSection>
        <DashboardSection title="Payments by Method and Currency">
          {Object.keys(data.paymentsByMethod).length === 0 ? <SoapSmileEmptyState icon="reports"><p>No payments in this period.</p></SoapSmileEmptyState> : <div className="report-value-list">{Object.entries(data.paymentsByMethod).sort(([first], [second]) => first.localeCompare(second)).map(([method, currencies]) => <div key={method}><span>{formatStatus(method)}</span><strong>{totals(currencies)}</strong></div>)}</div>}
        </DashboardSection>
        <DashboardSection title="Current Outstanding Balance">
          <p className="report-caption">Current snapshot, not a historical balance for the selected dates.</p>
          {Object.keys(data.outstandingByCurrency).length === 0 ? <SoapSmileEmptyState icon="reports"><p>No outstanding balances.</p></SoapSmileEmptyState> : <div className="report-value-list">{Object.entries(data.outstandingByCurrency).sort(([first], [second]) => first.localeCompare(second)).map(([currency, amount]) => <div key={currency}><span>{currency}</span><strong>{formatMoney(amount, currency)}</strong></div>)}</div>}
        </DashboardSection>
        <DashboardSection title="Doctor Activity">
          {data.doctorActivity.length === 0 ? <SoapSmileEmptyState icon="reports"><p>No doctor activity in this period.</p></SoapSmileEmptyState> : <div className="report-value-list">{data.doctorActivity.map((doctor) => <div key={doctor.id}><span>{doctor.label}</span><strong>{doctor.appointments} appointments · {doctor.visits} visits</strong></div>)}</div>}
        </DashboardSection>
      </div>
      </section>}
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
    .select('user_id, clinic_id, role, is_active, created_at')
    .eq('clinic_id', clinicId)
    .eq('role', 'doctor')
    .eq('is_active', true)

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

async function loadClinicianNames(userIds: string[]) {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))]
  if (!supabase || uniqueUserIds.length === 0) return {}

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name')
    .in('id', uniqueUserIds)
  const profiles = error ? [] : (data ?? []) as Array<{ id: string; display_name?: string | null }>
  return Object.fromEntries(uniqueUserIds.map((id) => [
    id,
    profiles.find((profile) => profile.id === id)?.display_name?.trim() || 'Clinic doctor',
  ]))
}

type ClinicalRecordReference = { patient_id: string; visit_id: string; doctor_id: string }
type ClinicalRecordContext = {
  patients: Record<string, Patient>
  visitDates: Record<string, string>
  doctorNames: Record<string, string>
}

async function loadClinicalRecordContext(clinicId: string, records: ClinicalRecordReference[]): Promise<ClinicalRecordContext | null> {
  const client = supabase
  if (!client || records.length === 0) return null

  const patientIds = [...new Set(records.map((record) => record.patient_id))]
  const visitIds = [...new Set(records.map((record) => record.visit_id))]
  const doctorIds = [...new Set(records.map((record) => record.doctor_id))]
  const [patientResult, visitResult, doctorNames] = await Promise.all([
    batchedResult(patientIds,(batch) => client.from('patients').select('*').eq('clinic_id', clinicId).in('id', batch).order('id')),
    batchedResult(visitIds,(batch) => client.from('visits').select('id, visit_date').eq('clinic_id', clinicId).in('id', batch).order('id')),
    loadClinicianNames(doctorIds),
  ])

  if (patientResult.error || visitResult.error) return null
  const patients = (patientResult.data ?? []) as Patient[]
  const visits = (visitResult.data ?? []) as Array<Pick<Visit, 'id' | 'visit_date'>>
  return {
    patients: Object.fromEntries(patients.map((patient) => [patient.id, patient])),
    visitDates: Object.fromEntries(visits.map((visit) => [visit.id, visit.visit_date])),
    doctorNames,
  }
}

function RecordPatientContext({ patient, visitDate, doctorName, onViewPatient }: { patient: Patient | undefined; visitDate: string | undefined; doctorName: string; onViewPatient: (patient: Patient) => void }) {
  const patientName = patient ? [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ') : null

  return <div className="clinical-record-context">
    {patientName && <strong>{patientName}</strong>}
    {patient?.patient_number && <span>File {patient.patient_number}</span>}
    {visitDate && <span>Visit {formatDateTime(visitDate)}</span>}
    <span>{doctorName}</span>
    {patient && <button className="button-secondary inline-button" onClick={() => onViewPatient(patient)} type="button">View Patient / History</button>}
  </div>
}

function PatientSearchField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <div className="search-field soap-search-field">
    <span>{label}</span>
    <div className="search-input-wrap"><SoapSmileIcon name="search" /><input aria-label={label} type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />{value && <button className="search-clear" type="button" aria-label={`Clear ${label.toLowerCase()}`} title="Clear search" onClick={() => onChange('')}><SoapSmileIcon name="close" /></button>}</div>
  </div>
}

function PrescriptionsView({ clinicId, onViewPatient }: { clinicId: string; onViewPatient: (patient: Patient) => void }) {
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([])
  const [recordContext, setRecordContext] = useState<ClinicalRecordContext | null>(null)
  const [recordPage,setRecordPage] = useState(1)
  const [hasOlder,setHasOlder] = useState(false)
  const correctionState = useCorrections(clinicId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadPrescriptions() {
      const client = supabase
      if (!client) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }
      setLoading(true)
      setError(null)
      const { data, error: queryError } = await client.from('prescriptions').select('*').eq('clinic_id',clinicId).order('created_at',{ascending:false}).order('id').range((recordPage-1)*100,recordPage*100-1)

      if (cancelled) return
      setHasOlder((data ?? []).length===100)
      if (queryError) {
        setLoading(false)
        setError('We could not load prescriptions for this clinic.')
        return
      }

      const rows = (data ?? []) as Prescription[]
      const context = await loadClinicalRecordContext(clinicId, rows.map((row) => ({
        patient_id: row.patient_id,
        visit_id: row.visit_id,
        doctor_id: row.prescribing_doctor_id,
      })))
      if (cancelled) return
      if (rows.length > 0 && !context) {
        setLoading(false)
        setError('We could not load the linked patient and visit details.')
        return
      }
      setPrescriptions(rows)
      setRecordContext(context)
      setLoading(false)
    }

    void loadPrescriptions()
    return () => { cancelled = true }
  }, [clinicId,recordPage])

  return <div className="patients-page"><div className="form-actions"><button type="button" className="button-secondary" disabled={loading || recordPage===1} onClick={() => setRecordPage(recordPage-1)}>Newer records</button><span>History page {recordPage}</span><button type="button" className="button-secondary" disabled={loading || !hasOlder} onClick={() => setRecordPage(recordPage+1)}>Older records</button></div>{correctionState.error && <p role="alert">{correctionState.error}</p>}
    <div className="page-heading"><div><p className="eyebrow">Clinical records</p><h1>Prescriptions</h1><p className="panel-copy">Prescriptions recorded during patient visits.</p></div></div>
    {loading && <SoapSmileLoadingState>Loading prescriptions...</SoapSmileLoadingState>}
    {!loading && error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    {!loading && !error && !correctionState.loading && !correctionState.error && prescriptions.length === 0 && <SoapSmileEmptyState icon="prescriptions"><h2>No prescriptions recorded</h2></SoapSmileEmptyState>}
    {!loading && !error && !correctionState.loading && !correctionState.error && prescriptions.length > 0 && <div className="clinical-record-list">{prescriptions.map((original) => {
      const prescription=effectiveRecord(original,correctionState.rows,'prescription')
      if (!prescription) return <article key={original.id}><strong>Withdrawn prescription</strong><RecordPatientContext patient={recordContext?.patients[original.patient_id]} visitDate={recordContext?.visitDates[original.visit_id]} doctorName="Historical evidence retained" onViewPatient={onViewPatient} /></article>
      const patient = recordContext?.patients[prescription.patient_id]
      const details = [prescription.strength, prescription.dose, prescription.route, prescription.frequency, prescription.duration].filter(Boolean)
      const doctorName = recordContext?.doctorNames[prescription.prescribing_doctor_id] ?? 'Clinic doctor'
      return <article className="clinical-record" key={prescription.id}>
        <RecordPatientContext patient={patient} visitDate={recordContext?.visitDates[prescription.visit_id]} doctorName={`Prescribed by ${doctorName}`} onViewPatient={onViewPatient} />
        <strong className="record-primary"><SoapSmileIcon name="prescriptions" />{prescription.medicine}</strong>
        {details.length > 0 && <p>{details.join(' · ')}</p>}
        {prescription.quantity !== null && prescription.quantity !== undefined && <p>Quantity: {prescription.quantity}</p>}
        {prescription.instructions && <p>{prescription.instructions}</p>}
      </article>
    })}</div>}
  </div>
}

function InvestigationsView({ clinicId, onViewPatient }: { clinicId: string; onViewPatient: (patient: Patient) => void }) {
  const [investigations, setInvestigations] = useState<Investigation[]>([])
  const [recordContext, setRecordContext] = useState<ClinicalRecordContext | null>(null)
  const [recordPage,setRecordPage] = useState(1)
  const [hasOlder,setHasOlder] = useState(false)
  const correctionState = useCorrections(clinicId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadInvestigations() {
      const client = supabase
      if (!client) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }
      setLoading(true)
      setError(null)
      const { data, error: queryError } = await client.from('investigations').select('*').eq('clinic_id',clinicId).order('created_at',{ascending:false}).order('id').range((recordPage-1)*100,recordPage*100-1)

      if (cancelled) return
      setHasOlder((data ?? []).length===100)
      if (queryError) {
        setLoading(false)
        setError('We could not load investigations for this clinic.')
        return
      }

      const rows = (data ?? []) as Investigation[]
      const context = await loadClinicalRecordContext(clinicId, rows.map((row) => ({
        patient_id: row.patient_id,
        visit_id: row.visit_id,
        doctor_id: row.requesting_doctor_id,
      })))
      if (cancelled) return
      if (rows.length > 0 && !context) {
        setLoading(false)
        setError('We could not load the linked patient and visit details.')
        return
      }
      setInvestigations(rows)
      setRecordContext(context)
      setLoading(false)
    }

    void loadInvestigations()
    return () => { cancelled = true }
  }, [clinicId,recordPage])

  return <div className="patients-page"><div className="form-actions"><button type="button" className="button-secondary" disabled={loading || recordPage===1} onClick={() => setRecordPage(recordPage-1)}>Newer records</button><span>History page {recordPage}</span><button type="button" className="button-secondary" disabled={loading || !hasOlder} onClick={() => setRecordPage(recordPage+1)}>Older records</button></div>{correctionState.error && <p role="alert">{correctionState.error}</p>}
    <div className="page-heading"><div><p className="eyebrow">Clinical records</p><h1>Investigations</h1><p className="panel-copy">Investigations requested during patient visits.</p></div></div>
    {loading && <SoapSmileLoadingState>Loading investigations...</SoapSmileLoadingState>}
    {!loading && error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    {!loading && !error && !correctionState.loading && !correctionState.error && investigations.length === 0 && <SoapSmileEmptyState icon="investigations"><h2>No investigations recorded</h2></SoapSmileEmptyState>}
    {!loading && !error && !correctionState.loading && !correctionState.error && investigations.length > 0 && <div className="clinical-record-list">{investigations.map((original) => {
      const investigation=effectiveRecord(original,correctionState.rows,'investigation')
      if (!investigation) return <article key={original.id}><strong>Withdrawn investigation request</strong><RecordPatientContext patient={recordContext?.patients[original.patient_id]} visitDate={recordContext?.visitDates[original.visit_id]} doctorName="Historical evidence retained" onViewPatient={onViewPatient} /></article>
      const patient = recordContext?.patients[investigation.patient_id]
      const doctorName = recordContext?.doctorNames[investigation.requesting_doctor_id] ?? 'Clinic doctor'
      const resultDate = investigation.result_date ? formatDate(investigation.result_date) : null
      return <article className="clinical-record" key={investigation.id}>
        <RecordPatientContext patient={patient} visitDate={recordContext?.visitDates[investigation.visit_id]} doctorName={`Requested by ${doctorName}`} onViewPatient={onViewPatient} />
        <strong className="record-primary"><SoapSmileIcon name="investigations" />{investigation.investigation_type}</strong>
        {investigation.status && <span className="investigation-status">{investigation.status}</span>}{investigation.result && <p><b>Result:</b> {investigation.result}</p>}{resultDate && <p className="record-result-date">Result date: {resultDate}</p>}
        {investigation.notes && <p>{investigation.notes}</p>}
      </article>
    })}</div>}
  </div>
}

type AppointmentView = 'upcoming' | 'today' | 'waiting' | 'active'
type QueueExitStatus = 'cancelled' | 'no_show'

function AppointmentsView({ clinicId, timezone, initialAppointment, onViewPatient, userId, role, onOpenPatients }: { clinicId: string; timezone: string; initialAppointment: Appointment | null; onViewPatient: (patient: Patient) => void; userId: string; role: UserRole; onOpenPatients: () => void }) {
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [waitingAppointments, setWaitingAppointments] = useState<Appointment[]>([])
  const [patients, setPatients] = useState<Record<string, Patient>>({})
  const [doctors, setDoctors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<AppointmentView>('upcoming')
  const [queueExit, setQueueExit] = useState<{ appointment: Appointment; status: QueueExitStatus } | null>(null)
  const [queueSuccess, setQueueSuccess] = useState<string | null>(null)
  const [transitioningId, setTransitioningId] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [activeConsultation, setActiveConsultation] = useState<{ appointment: Appointment; patient: Patient; visit: Visit } | null>(null)

  const [closedVisit, setClosedVisit] = useState<{ appointment: Appointment; patient: Patient; visit: Visit } | null>(null)
  const [creatingInvoice, setCreatingInvoice] = useState(false)
  const [createdInvoice, setCreatedInvoice] = useState<Invoice | null>(null)
  const [selectedAppointmentId, setSelectedAppointmentId] = useState<string | null>(initialAppointment?.id ?? null)
  const startLock = useRef(false)
  useUnsavedWorkspace(false, transitioningId !== null)

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
      const today = todayInputValue(timezone)
      const [appointmentResult, waitingResult] = await Promise.all([
        pagedResult(() => supabase!.from('appointments').select('*').eq('clinic_id', clinicId).gte('appointment_date', today).order('appointment_date', { ascending: true }).order('start_time', { ascending: true }).order('id')),
        pagedResult(() => supabase!.from('appointments').select('*').eq('clinic_id', clinicId).in('status', ['arrived', 'waiting', 'in_progress']).order('appointment_date', { ascending: true }).order('start_time', { ascending: true }).order('id')),
      ])

      if (cancelled) return
      setLoading(false)
      const linkedPatientIds=[...new Set([...(appointmentResult.data ?? []) as Appointment[],...(waitingResult.data ?? []) as Appointment[]].map((row) => row.patient_id))]
      const patientResult=await batchedResult(linkedPatientIds,(batch) => supabase!.from('patients').select('*').eq('clinic_id',clinicId).in('id',batch).order('id'))
      if (cancelled) return
      if (appointmentResult.error || waitingResult.error || patientResult.error) {
        setError(appointmentResult.error || waitingResult.error ? 'We could not load appointments.' : 'We could not load appointment patient details.')
        return
      }

      const patientMap = Object.fromEntries(((patientResult.data ?? []) as Patient[]).map((patient) => [patient.id, patient]))
      const appointmentRows = (appointmentResult.data ?? []) as Appointment[]
      const waitingRows = (waitingResult.data ?? []) as Appointment[]
      const doctorIds = [...new Set([...appointmentRows, ...waitingRows].map((appointment) => appointment.doctor_id).filter((id): id is string => Boolean(id)))]
      const doctorMap = await loadClinicianNames(doctorIds)
      if (cancelled) return
      setAppointments(appointmentRows)
      setWaitingAppointments(waitingRows)
      setPatients(patientMap)
      setDoctors(doctorMap)
    }

    void loadAppointments()
    return () => {
      cancelled = true
    }
  }, [clinicId, timezone, refreshVersion])

  const today = todayInputValue(timezone)
  const todayAppointments = appointments.filter((appointment) => appointment.appointment_date === today)
  const activeAppointments = waitingAppointments.filter((appointment) => appointment.status === 'in_progress' && (role === 'admin' || appointment.doctor_id === userId))
  const visibleWaitingAppointments = waitingAppointments.filter((appointment) => appointment.status !== 'in_progress').filter((appointment) => role !== 'doctor' || appointment.doctor_id === userId)
  const displayedAppointments = activeView === 'active' ? activeAppointments : activeView === 'today' ? todayAppointments : activeView === 'waiting' ? visibleWaitingAppointments : appointments
  const hasAppointments = appointments.length > 0 || visibleWaitingAppointments.length > 0 || activeAppointments.length > 0

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
    if (startLock.current || !['admin', 'doctor'].includes(role) || !['waiting', 'in_progress'].includes(appointment.status) || (role === 'doctor' && appointment.doctor_id !== userId)) return
    if (!supabase) {
      setTransitionError('Supabase is not configured.')
      return
    }

    setTransitioningId(appointment.id)
    setTransitionError(null)
    startLock.current = true
    try {
      const { data, error: startError } = await supabase.rpc('start_consultation', { p_appointment_id: appointment.id } as never)
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
    } catch {
      setTransitionError('The consultation could not be confirmed. Refresh and use Resume Consultation if it has started.')
    } finally {
      startLock.current = false
      setTransitioningId(null)
    }
  }

  async function confirmQueueExit(reason: string) {
    if (!supabase || !queueExit) throw new Error('The appointment is unavailable. Refresh and try again.')
    const { data, error: exitError } = await supabase.rpc('exit_appointment_queue', {
      p_appointment_id: queueExit.appointment.id, p_status: queueExit.status, p_reason: reason,
    } as never)
    if (exitError || !data) throw new Error(exitError?.code === 'P0001' ? exitError.message : 'We could not update the appointment. Refresh and try again.')
    const updated = data as Appointment
    setAppointments((current) => current.map((item) => item.id === updated.id ? updated : item))
    setWaitingAppointments((current) => current.filter((item) => item.id !== updated.id))
    setQueueSuccess(updated.status === 'cancelled' ? 'Appointment cancelled and removed from the active queue.' : 'Appointment marked no-show / left and removed from the active queue.')
    setQueueExit(null)
    setRefreshVersion((version) => version + 1)
  }

  function finishConsultation(visit: Visit) {
    if (activeConsultation) setClosedVisit({ ...activeConsultation, appointment: { ...activeConsultation.appointment, status: 'completed' }, visit })
    setCreatedInvoice(null)
    setActiveConsultation(null)
    setRefreshVersion((version) => version + 1)
  }

  if (activeConsultation) return <ConsultationPanel key={activeConsultation.visit.id} appointment={activeConsultation.appointment} patient={activeConsultation.patient} visit={activeConsultation.visit} userId={userId} role={role} clinicianLabel={doctors[activeConsultation.visit.doctor_id] ?? 'Assigned clinician'} onCompleted={finishConsultation} onCancel={() => setActiveConsultation(null)} />
  if (closedVisit && creatingInvoice && (role === 'admin' || role === 'receptionist')) return <InvoiceForm clinicId={clinicId} patient={closedVisit.patient} visit={closedVisit.visit} onCancel={() => setCreatingInvoice(false)} onCreated={(invoice) => { setCreatedInvoice(invoice); setCreatingInvoice(false) }} />
  if (closedVisit) return <section className="registration-panel"><h2>{createdInvoice ? 'Invoice created' : 'Visit closed'}</h2><p>{closedVisit.patient.first_name} {closedVisit.patient.last_name} · File {closedVisit.patient.patient_number} · Visit {formatDateTime(closedVisit.visit.visit_date)}</p>{createdInvoice ? <p>Invoice {createdInvoice.invoice_number} created. Payment is recorded separately in the patient file.</p> : <p>Clinical information is saved. {role === 'doctor' ? 'Reception or an administrator can now create the invoice.' : 'Create an invoice when ready; closing does not create charges.'}</p>}<div className="form-actions">{!createdInvoice && (role === 'admin' || role === 'receptionist') && <button type="button" onClick={() => setCreatingInvoice(true)}>Create Invoice</button>}<button type="button" className="button-secondary" onClick={() => onViewPatient(closedVisit.patient)}>View Patient</button><button type="button" className="button-secondary" onClick={() => { setClosedVisit(null); setSelectedAppointmentId(null) }}>Return to Appointments</button></div></section>
  const selectedAppointment = [...appointments, ...waitingAppointments].find((row) => row.id === selectedAppointmentId)
  if (selectedAppointmentId && !loading) return <section className="profile-page"><button className="back-button" type="button" onClick={() => setSelectedAppointmentId(null)}>← Back to appointments</button><h2>Appointment</h2>{transitionError && <SoapSmileFeedback tone="error">{transitionError}</SoapSmileFeedback>}{selectedAppointment ? <AppointmentCard appointment={selectedAppointment} patient={patients[selectedAppointment.patient_id]} doctorName={doctors[selectedAppointment.doctor_id ?? '']} role={role} userId={userId} onTransition={transitionAppointment} onStartConsultation={startConsultation} onQueueExit={(appointment, status) => setQueueExit({ appointment, status })} transitioning={transitioningId === selectedAppointment.id} /> : <p>Appointment unavailable. Return to appointments and refresh.</p>}{queueExit && <QueueExitDialog appointment={queueExit.appointment} patient={patients[queueExit.appointment.patient_id]} status={queueExit.status} onClose={() => setQueueExit(null)} onConfirm={confirmQueueExit} />}{queueSuccess && <SoapSmileFeedback tone="success">{queueSuccess}</SoapSmileFeedback>}</section>

  return (
    <div className="appointments-page">
      <div className="page-heading"><div><p className="eyebrow">Care coordination</p><h1>Appointments</h1><p className="panel-copy">Schedule and manage today\'s patient arrivals.</p></div><div className="appointments-heading-actions"><button className="button-secondary refresh-button" onClick={() => setRefreshVersion((version) => version + 1)} type="button">Refresh</button><button className="primary-action" onClick={onOpenPatients} type="button"><SoapSmileIcon name="patients" />Find patient</button></div></div>
      <div className="appointment-tabs" role="tablist" aria-label="Appointment views"><button className={activeView === 'upcoming' ? 'active' : ''} onClick={() => setActiveView('upcoming')} role="tab" aria-selected={activeView === 'upcoming'} type="button">Upcoming <span>{appointments.length}</span></button><button className={activeView === 'today' ? 'active' : ''} onClick={() => setActiveView('today')} role="tab" aria-selected={activeView === 'today'} type="button">Today <span>{todayAppointments.length}</span></button><button className={activeView === 'waiting' ? 'active' : ''} onClick={() => setActiveView('waiting')} role="tab" aria-selected={activeView === 'waiting'} type="button">Waiting queue <span>{visibleWaitingAppointments.length}</span></button>{(role === 'admin' || role === 'doctor') && <button className={activeView === 'active' ? 'active' : ''} onClick={() => setActiveView('active')} role="tab" aria-selected={activeView === 'active'} type="button">In progress <span>{activeAppointments.length}</span></button>}</div>
      {loading && <SoapSmileLoadingState>Loading upcoming appointments...</SoapSmileLoadingState>}
      {!loading && error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
      {!loading && !error && transitionError && <SoapSmileFeedback tone="error">{transitionError}</SoapSmileFeedback>}
      {queueSuccess && <SoapSmileFeedback tone="success">{queueSuccess}</SoapSmileFeedback>}
      {queueExit && <QueueExitDialog appointment={queueExit.appointment} patient={patients[queueExit.appointment.patient_id]} status={queueExit.status} onClose={() => setQueueExit(null)} onConfirm={confirmQueueExit} />}
      {!loading && !error && !hasAppointments && <SoapSmileEmptyState icon="appointments"><h2>No upcoming appointments</h2><p>Appointments booked from patient files will appear here.</p></SoapSmileEmptyState>}
      {!loading && !error && hasAppointments && displayedAppointments.length === 0 && <SoapSmileEmptyState icon="appointments"><h2>{activeView === 'active' ? 'No unfinished consultations' : activeView === 'waiting' ? 'No patients waiting' : activeView === 'today' ? 'No appointments today' : 'No upcoming appointments'}</h2><p>{activeView === 'waiting' ? 'Patients sent to waiting will appear here.' : 'Appointments booked from patient files will appear here.'}</p></SoapSmileEmptyState>}
      {!activeConsultation && !loading && !error && displayedAppointments.length > 0 && <div className="appointment-list" tabIndex={0} role="region" aria-label="Appointment list">{displayedAppointments.map((appointment) => <AppointmentCard key={appointment.id} appointment={appointment} patient={patients[appointment.patient_id]} doctorName={doctors[appointment.doctor_id ?? '']} role={role} userId={userId} onTransition={transitionAppointment} onStartConsultation={startConsultation} onQueueExit={(appointment, status) => { setQueueSuccess(null); setQueueExit({ appointment, status }) }} transitioning={transitioningId === appointment.id} />)}</div>}
    </div>
  )
}

function QueueExitDialog({ appointment, patient, status, onClose, onConfirm }: { appointment: Appointment; patient?: PatientAppointmentSummary; status: QueueExitStatus; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!reason.trim()) { setError('Enter a short reason.'); return }
    setBusy(true)
    setError(null)
    try { await onConfirm(reason.trim()) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'We could not update the appointment.') }
    finally { setBusy(false) }
  }
  return <dialog ref={dialog} className="queue-exit-dialog" aria-labelledby="queue-exit-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={submit}>
      <h2 id="queue-exit-title">{status === 'cancelled' ? 'Cancel appointment' : 'Mark no-show / left'}</h2>
      {patient && <p><strong>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</strong> · File {patient.patient_number}</p>}
      <p>{formatDate(appointment.appointment_date)} · {formatTime(appointment.start_time)}. This removes the appointment from the active queue and preserves its history.</p>
      <label>Reason<textarea autoFocus required maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} placeholder="Brief operational reason; avoid clinical details" /></label>
      {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
      <div className="form-actions"><button type="button" className="button-secondary" onClick={onClose} disabled={busy}>Close</button><button type="submit" disabled={busy || !reason.trim()}>{busy ? 'Saving...' : 'Confirm'}</button></div>
    </form>
  </dialog>
}

function AppointmentCard({ appointment, patient, doctorName, role, userId, onTransition, onStartConsultation, onQueueExit, transitioning }: { appointment: Appointment; patient?: PatientAppointmentSummary; doctorName?: string; role: UserRole; userId: string; onTransition: (appointment: Appointment, nextStatus: 'arrived' | 'waiting') => void; onStartConsultation: (appointment: Appointment) => void; onQueueExit: (appointment: Appointment, status: QueueExitStatus) => void; transitioning: boolean }) {
  const canCheckIn = appointment.status === 'scheduled' || appointment.status === 'confirmed'
  const canSendToWaiting = appointment.status === 'arrived'
  const canStartConsultation = ['waiting', 'in_progress'].includes(appointment.status) && (role === 'admin' || (role === 'doctor' && appointment.doctor_id === userId))
  const canExitQueue = ['scheduled', 'confirmed', 'arrived', 'waiting'].includes(appointment.status) && (role === 'admin' || role === 'receptionist' || (role === 'doctor' && appointment.doctor_id === userId))
  function closeMenu(event: React.MouseEvent<HTMLButtonElement>) { event.currentTarget.closest('details')?.removeAttribute('open') }
  return <article className="appointment-card">
    <div className="appointment-date-block"><span>{formatDate(appointment.appointment_date)}</span><strong>{formatTime(appointment.start_time)}</strong><small>{formatTime(appointment.end_time)}</small></div>
    <div className="appointment-main"><p className="appointment-patient">{patient ? [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ') : 'Patient unavailable'}</p><p className="appointment-file">File {patient?.patient_number ?? '-'}</p>{appointment.service && <p className="appointment-reason">{appointment.service}</p>}</div>
    <div className="appointment-meta"><p>{doctorName ?? 'Doctor unavailable'}</p><span className={'appointment-status status-' + appointment.status}>{formatStatus(appointment.status)}</span>
      <div className="appointment-actions">
        {canCheckIn && <button onClick={() => onTransition(appointment, 'arrived')} disabled={transitioning} type="button">{transitioning ? 'Updating...' : 'Check In'}</button>}
        {canSendToWaiting && <button onClick={() => onTransition(appointment, 'waiting')} disabled={transitioning} type="button">{transitioning ? 'Updating...' : 'Send to Waiting'}</button>}
        {canStartConsultation && <button type="button" disabled={transitioning || !patient} onClick={() => onStartConsultation(appointment)}>{appointment.status === 'in_progress' ? 'Resume Consultation' : 'Start Consultation'}</button>}
        {canExitQueue && <details className="queue-action-menu"><summary aria-label="Appointment actions">Actions</summary><div>
          <button type="button" disabled={transitioning} onClick={(event) => { closeMenu(event); onQueueExit(appointment, 'cancelled') }}>Cancel appointment</button>
          <button type="button" disabled={transitioning} onClick={(event) => { closeMenu(event); onQueueExit(appointment, 'no_show') }}>No-show / Left</button>
        </div></details>}
      </div>
    </div>
  </article>
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

function ConsultationPanel({ appointment, patient, visit, userId, role, clinicianLabel, onCompleted, onCancel }: { appointment: Appointment; patient: Patient; visit: Visit; userId: string; role: UserRole; clinicianLabel: string; onCompleted: (visit: Visit) => void; onCancel: () => void }) {
  const [form, setForm] = useState<ConsultationFormValues>(() => consultationFormFromVisit(visit))
  const [saving, setSaving] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [section, setSection] = useState<'notes' | 'procedures' | 'dental' | 'prescriptions' | 'investigations' | 'review'>('notes')
  const [savedForm, setSavedForm] = useState(() => consultationFormFromVisit(visit))
  const [recordCounts, setRecordCounts] = useState({ prescriptions: 0, investigations: 0, verified: false })
  const [dentalCount, setDentalCount] = useState<number | null>(null)
  const [procedureCount, setProcedureCount] = useState<number | null>(null)
  const actionLock = useRef(false)
  useUnsavedWorkspace(JSON.stringify(form) !== JSON.stringify(savedForm), saving || completing, true)
  const leave = () => { if (confirmWorkspaceLeave()) onCancel() }

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
    if (actionLock.current) return false
    if (!supabase) {
      setError('Supabase is not configured.')
      return false
    }
    actionLock.current = true
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const { error: saveError } = await supabase.rpc('save_consultation', rpcPayload() as never)
      if (saveError) {
        setError('We could not save this consultation. Refresh and try again.')
        return false
      }
      setSavedForm({ ...form })
      setMessage('Notes saved.')
      return true
    } catch {
      setError('The save could not be confirmed. Stay in this visit and review before continuing.')
      return false
    } finally {
      actionLock.current = false
      setSaving(false)
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await saveDraft()
  }

  async function completeConsultation() {
    if (procedureCount === null || procedureCount === 0) { setError('Record at least one procedure or Consultation Only before closing this visit.'); setSection('procedures'); return }
    if (actionLock.current || !confirmWorkspaceLeave(true)) return
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }
    actionLock.current = true
    setCompleting(true)
    setError(null)
    setMessage(null)
    try {
      const { data, error: completeError } = await supabase.rpc('complete_consultation', rpcPayload() as never)
      if (completeError || !data) {
        setError(completeError?.message || 'We could not complete this consultation. Refresh and try again.')
        return
      }
      setMessage('Consultation completed and added to visit history.')
      onCompleted(data as Visit)
    } catch {
      setError('Closure could not be confirmed. Refresh appointment status before trying to record more information.')
    } finally {
      actionLock.current = false
      setCompleting(false)
    }
  }

  return <section className="profile-page consultation-workspace" aria-labelledby="consultation-heading">
    <button className="back-button" type="button" disabled={saving || completing} onClick={leave}>← Back to appointments</button>
    <div className="profile-header"><div><p className="eyebrow">Consultation</p><h2 id="consultation-heading">{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</h2><p>File {patient.patient_number} · {formatDate(appointment.appointment_date)} {formatTime(appointment.start_time)} · {clinicianLabel} · In progress</p></div><button type="button" disabled={saving || completing} onClick={() => setSection('review')}>Review & Close Visit</button></div>
    <details className="profile-card"><summary>Current Clinical Profile</summary><ClinicalProfileValues profile={patient} /></details>
    <div className="appointment-tabs" role="tablist" aria-label="Consultation sections">{([['notes', 'Consultation'], ['procedures', 'Procedures'], ['dental', 'Dental Chart'], ['prescriptions', 'Prescriptions (' + recordCounts.prescriptions + ')'], ['investigations', 'Investigations (' + recordCounts.investigations + ')'], ['review', 'Review']] as const).map(([key, label]) => <button type="button" key={key} id={'consultation-tab-' + key} aria-controls={'consultation-section-' + key} role="tab" aria-selected={section === key} className={section === key ? 'active' : ''} onClick={() => setSection(key)}>{label}</button>)}</div>
    <div id="consultation-section-notes" role="tabpanel" aria-labelledby="consultation-tab-notes" hidden={section !== 'notes'} className="registration-panel"><form className="patient-form" onSubmit={handleSubmit}><fieldset disabled={saving || completing} style={{ display: 'contents' }}><label>Chief complaint<textarea value={form.chief_complaint} onChange={(event) => updateField('chief_complaint', event.target.value)} rows={3} /></label><label>History of present illness<textarea value={form.hpi} onChange={(event) => updateField('hpi', event.target.value)} rows={3} /></label><label>Examination<textarea value={form.examination} onChange={(event) => updateField('examination', event.target.value)} rows={3} /></label><label>Assessment / diagnosis<textarea value={form.assessment} onChange={(event) => updateField('assessment', event.target.value)} rows={3} /></label><label>Treatment plan<textarea value={form.treatment_plan} onChange={(event) => updateField('treatment_plan', event.target.value)} rows={3} /></label><label>Follow-up date<input type="date" value={form.follow_up_date} onChange={(event) => updateField('follow_up_date', event.target.value)} /></label><label className="full-width">Follow-up instructions<textarea value={form.follow_up_instructions} onChange={(event) => updateField('follow_up_instructions', event.target.value)} rows={3} /></label><label className="full-width">Clinical notes<textarea value={form.clinical_notes} onChange={(event) => updateField('clinical_notes', event.target.value)} rows={4} /></label></fieldset><div className="form-actions"><button className="button-secondary" disabled={saving || completing} onClick={() => { void saveDraft() }} type="button">{saving ? <><SoapSmileCompanion state="saving" />Saving...</> : 'Save Notes'}</button><button type="button" disabled={saving || completing} onClick={() => setSection('review')}>Review & Close Visit</button></div></form></div>
    <div id="consultation-section-procedures" role="tabpanel" aria-labelledby="consultation-tab-procedures" hidden={section !== 'procedures'}><VisitProcedures visit={visit} userId={userId} role={role} canCreate disabled={saving || completing} onCount={setProcedureCount} /></div>
    <div id="consultation-section-dental" role="tabpanel" aria-labelledby="consultation-tab-dental" hidden={section !== 'dental'}><DentalChart clinicId={visit.clinic_id} visit={visit} userId={userId} role={role} canCreate={!saving && !completing} defaultOpen onActivityCount={setDentalCount} /></div>
    <div hidden={section !== 'prescriptions' && section !== 'investigations'}><VisitClinicalRecordsPanel clinicId={visit.clinic_id} patientId={visit.patient_id} visitId={visit.id} doctorId={visit.doctor_id} disabled={saving || completing} activeSection={section === 'investigations' ? 'investigations' : 'prescriptions'} onCounts={setRecordCounts} /></div>
    {section === 'review' && <section className="profile-card" id="consultation-section-review" role="tabpanel" aria-labelledby="consultation-tab-review"><h3>Review & Close Visit</h3><dl className="detail-list"><DetailItem label="Procedures performed (required)" value={procedureCount === null ? 'Not yet verified; open Procedures and refresh' : procedureCount === 0 ? 'Record at least one procedure or Consultation Only' : procedureCount + ' effective procedure record(s)'} /><DetailItem label="Notes / findings" value={[form.chief_complaint, form.examination, form.assessment, form.clinical_notes].some((value) => value.trim()) ? 'Recorded in this consultation; current notes will be saved on close.' : 'Not recorded'} /><DetailItem label="Dental chart" value={dentalCount === null ? 'Activity not yet verified; review Dental Chart if needed.' : dentalCount + ' saved entries for this visit'} /><DetailItem label="Prescriptions" value={recordCounts.verified ? String(recordCounts.prescriptions) : 'Records not yet verified'} /><DetailItem label="Investigations" value={recordCounts.verified ? String(recordCounts.investigations) : 'Records not yet verified'} /><DetailItem label="Billing" value="Invoice creation is available after clinical closure to reception or an administrator." /></dl><p>At least one structured procedure or Consultation Only is required. Other records remain optional. Closing saves notes and prevents ordinary additions.</p>{(procedureCount === null || procedureCount === 0) && <button type="button" className="button-secondary" onClick={() => setSection('procedures')}>+ Record Procedure</button>}<div className="form-actions"><button type="button" className="button-secondary" onClick={() => setSection('notes')} disabled={completing}>Back to consultation</button><button type="button" disabled={saving || completing || procedureCount === null || procedureCount === 0} onClick={() => void completeConsultation()}>{completing ? 'Closing visit...' : 'Close Visit'}</button></div></section>}
    {message && <SoapSmileFeedback tone="success">{message}</SoapSmileFeedback>}{error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
  </section>
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

function VisitClinicalRecordsPanel({ clinicId, patientId, visitId, doctorId, disabled, activeSection, onCounts }: { clinicId: string; patientId: string; visitId: string; doctorId: string; disabled: boolean; activeSection?: 'prescriptions' | 'investigations'; onCounts?: (counts: { prescriptions: number; investigations: number; verified: boolean }) => void }) {
  const correctionState=useCorrections(clinicId,visitId)
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([])
  const [investigations, setInvestigations] = useState<Investigation[]>([])
  const [prescriptionForm, setPrescriptionForm] = useState<PrescriptionFormValues>(initialPrescriptionForm)
  const [investigationForm, setInvestigationForm] = useState<InvestigationFormValues>(initialInvestigationForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useUnsavedWorkspace(JSON.stringify(prescriptionForm) !== JSON.stringify(initialPrescriptionForm) || JSON.stringify(investigationForm) !== JSON.stringify(initialInvestigationForm), saving)
  const recordLock = useRef(false)
  useEffect(() => { onCounts?.({ prescriptions: prescriptions.length, investigations: investigations.length, verified: !loading && !error }) }, [onCounts, prescriptions.length, investigations.length, loading, error])

  useEffect(() => {
    let cancelled = false
    async function loadRecords() {
      if (!supabase) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }
      const [prescriptionResult, investigationResult] = await Promise.all([
        pagedResult(() => supabase!.from('prescriptions').select('*').eq('clinic_id', clinicId).eq('visit_id', visitId).order('created_at', { ascending: true }).order('id')),
        pagedResult(() => supabase!.from('investigations').select('*').eq('clinic_id', clinicId).eq('visit_id', visitId).order('created_at', { ascending: true }).order('id')),
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
    if (recordLock.current || disabled) return
    if (!prescriptionForm.medicine.trim() || !supabase) {
      setError(!supabase ? 'Supabase is not configured.' : 'Medicine is required.')
      return
    }
    recordLock.current = true
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
    recordLock.current = false
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
    if (recordLock.current || disabled) return
    if (!investigationForm.investigation_type.trim() || !supabase) {
      setError(!supabase ? 'Supabase is not configured.' : 'Investigation type is required.')
      return
    }
    recordLock.current = true
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
    recordLock.current = false
    setSaving(false)
    if (insertError || !data) {
      setError('We could not add this investigation. Confirm that the consultation is still active.')
      return
    }
    setInvestigations((current) => [...current, data as Investigation])
    setInvestigationForm(initialInvestigationForm)
  }

  return <section className="clinical-records-panel"><div className="section-heading"><div><p className="card-label">Visit records</p><h3>{activeSection === 'prescriptions' ? 'Prescriptions' : activeSection === 'investigations' ? 'Investigations' : 'Prescriptions and investigations'}</h3></div><span className="history-count">{prescriptions.length + investigations.length} records</span></div>{loading && <SoapSmileLoadingState>Loading visit records...</SoapSmileLoadingState>}{!loading && !correctionState.loading && !correctionState.error && <div className="clinical-records-grid" style={activeSection ? { gridTemplateColumns: '1fr' } : undefined}><section id={activeSection ? 'consultation-section-prescriptions' : undefined} role={activeSection ? 'tabpanel' : undefined} aria-labelledby={activeSection ? 'consultation-tab-prescriptions' : undefined} hidden={activeSection === 'investigations'}><h4>Prescriptions</h4>{prescriptions.length === 0 ? <SoapSmileEmptyState><p>No prescriptions recorded.</p></SoapSmileEmptyState> : <div className="clinical-record-list">{prescriptions.map((original) => { const prescription=effectiveRecord(original,correctionState.rows,'prescription'); return prescription ? <article className="clinical-record" key={prescription.id}><strong>{prescription.medicine}</strong><span>{[prescription.strength, prescription.dose, prescription.route, prescription.frequency, prescription.duration].filter(Boolean).join(' · ') || 'Details not specified'}</span>{prescription.instructions && <p>{prescription.instructions}</p>}</article> : <article key={original.id}>Withdrawn prescription - see patient history</article> })}</div>}<form className="record-form" onSubmit={addPrescription}><input aria-label="Medicine" placeholder="Medicine" value={prescriptionForm.medicine} onChange={(event) => setPrescriptionForm((current) => ({ ...current, medicine: event.target.value }))} disabled={disabled || saving} required /><input aria-label="Strength" placeholder="Strength" value={prescriptionForm.strength} onChange={(event) => setPrescriptionForm((current) => ({ ...current, strength: event.target.value }))} disabled={disabled || saving} /><input aria-label="Dose" placeholder="Dose" value={prescriptionForm.dose} onChange={(event) => setPrescriptionForm((current) => ({ ...current, dose: event.target.value }))} disabled={disabled || saving} /><input aria-label="Route" placeholder="Route" value={prescriptionForm.route} onChange={(event) => setPrescriptionForm((current) => ({ ...current, route: event.target.value }))} disabled={disabled || saving} /><input aria-label="Frequency" placeholder="Frequency" value={prescriptionForm.frequency} onChange={(event) => setPrescriptionForm((current) => ({ ...current, frequency: event.target.value }))} disabled={disabled || saving} /><input aria-label="Duration" placeholder="Duration" value={prescriptionForm.duration} onChange={(event) => setPrescriptionForm((current) => ({ ...current, duration: event.target.value }))} disabled={disabled || saving} /><input type="number" min="0" step="any" aria-label="Quantity" placeholder="Quantity" value={prescriptionForm.quantity} onChange={(event) => setPrescriptionForm((current) => ({ ...current, quantity: event.target.value }))} disabled={disabled || saving} /><input aria-label="Instructions" placeholder="Instructions" value={prescriptionForm.instructions} onChange={(event) => setPrescriptionForm((current) => ({ ...current, instructions: event.target.value }))} disabled={disabled || saving} /><button type="submit" disabled={disabled || saving}>{saving ? <><SoapSmileLoader size="button" />Adding...</> : 'Add prescription'}</button></form></section><section id={activeSection ? 'consultation-section-investigations' : undefined} role={activeSection ? 'tabpanel' : undefined} aria-labelledby={activeSection ? 'consultation-tab-investigations' : undefined} hidden={activeSection === 'prescriptions'}><h4>Investigations</h4>{investigations.length === 0 ? <SoapSmileEmptyState><p>No investigations requested.</p></SoapSmileEmptyState> : <div className="clinical-record-list">{investigations.map((original) => { const investigation=effectiveRecord(original,correctionState.rows,'investigation'); return investigation ? <article className="clinical-record" key={investigation.id}><strong>{investigation.investigation_type}</strong><span>{investigation.status || 'Requested'}</span>{investigation.notes && <p>{investigation.notes}</p>}</article> : <article key={original.id}>Withdrawn request - see patient history</article> })}</div>}<form className="record-form" onSubmit={addInvestigation}><input aria-label="Investigation type" placeholder="Investigation type" value={investigationForm.investigation_type} onChange={(event) => setInvestigationForm((current) => ({ ...current, investigation_type: event.target.value }))} disabled={disabled || saving} required /><input aria-label="Status" placeholder="Status" value={investigationForm.status} onChange={(event) => setInvestigationForm((current) => ({ ...current, status: event.target.value }))} disabled={disabled || saving} /><textarea aria-label="Notes" placeholder="Notes" value={investigationForm.notes} onChange={(event) => setInvestigationForm((current) => ({ ...current, notes: event.target.value }))} disabled={disabled || saving} rows={2} /><button type="submit" disabled={disabled || saving}>{saving ? <><SoapSmileLoader size="button" />Adding...</> : 'Add investigation'}</button></form></section></div>}{correctionState.error && <p role="alert">{correctionState.error}</p>}{error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}</section>
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

function PatientsView({ clinicId, clinicName, clinicTimezone, userId, role, clinicianLabel, patientToOpen, onViewAppointment, onViewReceipt, onPrintVisitSummary }: { clinicId: string; clinicName: string; clinicTimezone: string; userId: string; role: UserRole; clinicianLabel: string; patientToOpen: Patient | null; onViewAppointment: (appointment: Appointment) => void; onViewReceipt: ViewReceipt; onPrintVisitSummary: PrintVisitSummary }) {
  const [patients, setPatients] = useState<Patient[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [showRegistration, setShowRegistration] = useState(false)
  const [page,setPage] = useState(1)
  const [total,setTotal] = useState(0)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(() => patientToOpen)
  const [registeredPatient, setRegisteredPatient] = useState<Patient | null>(null)
  const [encounterToOpen, setEncounterToOpen] = useState<EncounterContext | null>(null)
  const [startingRegisteredVisit, setStartingRegisteredVisit] = useState(false)
  const registrationStartLock = useRef(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  useUnsavedWorkspace(false, startingRegisteredVisit)

  useEffect(() => {
    let cancelled = false

    async function loadPatients() {
      if (!supabase) {
        setLoading(false)
        setError('Supabase is not configured.')
        return
      }

      setLoading(true)
      const { data, count, error: queryError } = await searchPatients(clinicId,searchTerm,page)
      setTotal(count ?? 0)

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
  }, [clinicId, refreshVersion, searchTerm, page])

  const visiblePatients = patients

  function handleRegistered(patient: Patient) {
    setShowRegistration(false)
    setSelectedPatient(null)
    setEncounterToOpen(null)
    setRegisteredPatient(patient)
    setSuccess(`Patient file ${patient.patient_number} was registered successfully.`)
    setRefreshVersion((version) => version + 1)
  }

  async function startRegisteredVisit() {
    if (!registeredPatient || registrationStartLock.current) return
    registrationStartLock.current = true
    setStartingRegisteredVisit(true)
    setError(null)
    try {
      const result = await startEncounterContext({ p_clinic_id: clinicId, p_patient_id: registeredPatient.id })
      if (result.error) throw new Error(result.error.message)
      if (!result.data) throw new Error('The encounter could not be confirmed. Retry Book Appointment.')
      setEncounterToOpen(result.data)
      setSelectedPatient(registeredPatient)
      setRegisteredPatient(null)
    } catch {
      setError('We could not prepare appointment booking. Please try again.')
    } finally {
      registrationStartLock.current = false
      setStartingRegisteredVisit(false)
    }
  }

  function handlePatientUpdated(updatedPatient: Patient) {
    setPatients((current) => current.map((patient) => patient.id === updatedPatient.id ? updatedPatient : patient))
    setSelectedPatient(updatedPatient)
    setSuccess('Patient details updated successfully.')
    setRefreshVersion((version) => version + 1)
  }

  if (showRegistration) return <PatientRegistrationForm clinicId={clinicId} onCancel={() => setShowRegistration(false)} onRegistered={handleRegistered} />
  if (selectedPatient) return <PatientProfile key={clinicId + ':' + selectedPatient.id} onViewAppointment={onViewAppointment} initialEncounter={encounterToOpen?.patient_id === selectedPatient.id ? encounterToOpen : null} clinicId={clinicId} clinicName={clinicName} clinicTimezone={clinicTimezone} userId={userId} role={role} clinicianLabel={clinicianLabel} patient={selectedPatient} onBack={() => { if (!confirmWorkspaceLeave()) return; setSelectedPatient(null); setEncounterToOpen(null) }} onUpdated={handlePatientUpdated} onViewReceipt={onViewReceipt} onPrintVisitSummary={onPrintVisitSummary} />

  return (
    <div className="patients-page">
      <div className="page-heading">
        <div><p className="eyebrow">Patient management</p><h1>{selectedPatient ? 'Patient details' : 'Patients'}</h1><p className="panel-copy">{selectedPatient ? 'Review patient details and clinical background.' : 'Register and review the people receiving care at your clinic.'}</p></div>
        {!showRegistration && !registeredPatient && <button className="primary-action" onClick={() => { setSuccess(null); setError(null); setShowRegistration(true) }} type="button">Register New Patient</button>}
      </div>
      {success && <SoapSmileFeedback tone="success">{success}</SoapSmileFeedback>}
      {registeredPatient && <section className="encounter-next-step"><h2>Patient registered - next step</h2><p>{[registeredPatient.first_name, registeredPatient.middle_name, registeredPatient.last_name].filter(Boolean).join(' ')} · File {registeredPatient.patient_number}</p><p>Book an appointment or review the patient file.</p><div className="form-actions"><button type="button" disabled={startingRegisteredVisit} onClick={() => void startRegisteredVisit()}>{startingRegisteredVisit ? 'Preparing booking...' : 'Book Appointment'}</button><button type="button" className="button-secondary" disabled={startingRegisteredVisit} onClick={() => { setSelectedPatient(registeredPatient); setRegisteredPatient(null); setEncounterToOpen(null); setError(null) }}>View Patient</button></div></section>}
      {registeredPatient && error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
      {!selectedPatient && !registeredPatient && !showRegistration && <>
        {!showRegistration && <div className="patient-directory-summary"><div><span className="summary-overline">CLINIC ROSTER</span><strong>{total}</strong><span>patient files</span></div><p>{loading ? 'Loading clinic records...' : `${visiblePatients.length} ${visiblePatients.length === 1 ? 'match' : 'matches'}${searchTerm.trim() ? ' for this search' : ' in the directory'}`}</p></div>}
        <div className="patient-toolbar"><PatientSearchField label="Search patients" value={searchTerm} onChange={(value) => { setSearchTerm(value); setPage(1) }} placeholder="File number, name, or phone" /><p className="result-count">{loading ? 'Loading...' : `${visiblePatients.length} ${visiblePatients.length === 1 ? 'patient' : 'patients'}`}</p></div>
        {loading && <SoapSmileLoadingState>Loading patients...</SoapSmileLoadingState>}
        {!loading && error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
        {!loading && !error && patients.length === 0 && <SoapSmileEmptyState icon="patients"><h2>No patients yet</h2><p>Registered patients will appear here.</p></SoapSmileEmptyState>}
        {!loading && !error && patients.length > 0 && visiblePatients.length === 0 && <SoapSmileEmptyState icon="patients"><h2>No matching patients</h2><p>Try a different file number, name, or phone number.</p></SoapSmileEmptyState>}
        {!loading && !error && visiblePatients.length > 0 && <PatientTable patients={visiblePatients} onSelect={setSelectedPatient} />}
        <div className="form-actions"><button type="button" className="button-secondary" disabled={loading || page===1} onClick={() => setPage(page-1)}>Previous</button><span>Page {page} - {total} matches</span><button type="button" className="button-secondary" disabled={loading || page*50>=total} onClick={() => setPage(page+1)}>Next</button></div>
      </>}
    </div>
  )
}

function BillingView({ clinicId, clinicName, currency, onViewReceipt }: { clinicId: string; clinicName: string; currency: string; onViewReceipt: ViewReceipt }) {
  const [patients, setPatients] = useState<Patient[]>([])
  const [patientPage,setPatientPage] = useState(1)
  const [patientTotal,setPatientTotal] = useState(0)
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
      setLoadingPatients(true)
      const { data, count, error: queryError } = await searchPatients(clinicId,searchTerm,patientPage)
      setPatientTotal(count ?? 0)
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
  }, [clinicId,searchTerm,patientPage])

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
        pagedResult(() => supabase!.from('visits').select('*').eq('clinic_id', clinicId).eq('patient_id', billingPatientId).order('visit_date', { ascending: false }).order('id')),
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

  const visiblePatients = patients
  const [billingPage, setBillingPage] = useState(1)
  const billingPageSize = 8
  const billingPageCount = Math.max(1, Math.ceil(visiblePatients.length / billingPageSize))
  const effectiveBillingPage = Math.max(1, Math.min(billingPage, billingPageCount))
  const paginatedPatients = visiblePatients.slice((effectiveBillingPage - 1) * billingPageSize, effectiveBillingPage * billingPageSize)
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

  if (billingVisit && selectedPatient) return <InvoiceForm clinicId={clinicId} patient={selectedPatient} visit={billingVisit} onCancel={() => setBillingVisit(null)} onCreated={handleInvoiceCreated} />

  return (
    <div className="patients-page soap-billing-page">
      <div className="page-heading"><div><p className="eyebrow">Management</p><h1>Billing</h1><p className="panel-copy">Clinic currency: {currency}. Find a patient to review visits, invoices, and payments.</p></div></div>
      <div className="soap-billing-workspace">
        <aside className="soap-billing-finder"><div className="soap-workspace-panel-heading"><div><p className="eyebrow">Patient index</p><h2>Patient finder</h2></div><SoapSmileIcon name="search" /></div>
        <div className="patient-toolbar"><PatientSearchField label="Search patients" value={searchTerm} onChange={(value) => { setSearchTerm(value); setPatientPage(1) }} placeholder="File number, name, or phone" /><p className="result-count">{loadingPatients ? 'Loading...' : `${visiblePatients.length} ${visiblePatients.length === 1 ? 'patient' : 'patients'}`}</p></div>
        {loadingPatients && <SoapSmileLoadingState>Loading patients...</SoapSmileLoadingState>}
        {!selectedPatient && !loadingPatients && error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
        <div className="form-actions"><button type="button" disabled={loadingPatients || patientPage===1} onClick={() => setPatientPage(patientPage-1)}>Previous patient page</button><span>{patientTotal} matches</span><button type="button" disabled={loadingPatients || patientPage*50>=patientTotal} onClick={() => setPatientPage(patientPage+1)}>Next patient page</button></div>
        {!loadingPatients && !error && patients.length === 0 && <SoapSmileEmptyState icon="billing"><h2>No patients yet</h2><p>Registered patients will appear here.</p></SoapSmileEmptyState>}
        {!loadingPatients && !error && patients.length > 0 && visiblePatients.length === 0 && <SoapSmileEmptyState icon="billing"><h2>No matching patients</h2><p>Try a different file number, name, or phone number.</p></SoapSmileEmptyState>}
        {!loadingPatients && !error && visiblePatients.length > 0 && <>
          <SoapSmileBillingPatientList selectedId={selectedPatient?.id} patients={paginatedPatients} onSelect={(patient) => { setSelectedPatient(patient); setError(null); setVisits([]); setInvoices([]); setPayments({}); setBillingVisit(null) }} />
          {billingPageCount > 1 && <div className="compact-pagination" aria-label="Billing patient pagination"><button type="button" disabled={effectiveBillingPage === 1} onClick={() => setBillingPage(Math.max(1, effectiveBillingPage - 1))}>Previous</button><span>{effectiveBillingPage} / {billingPageCount}</span><button type="button" disabled={effectiveBillingPage === billingPageCount} onClick={() => setBillingPage(Math.min(billingPageCount, effectiveBillingPage + 1))}>Next</button></div>}
        </>}
        </aside>
        <section className="soap-billing-detail" aria-label="Patient financial workspace">
          {!selectedPatient ? <div className="soap-financial-welcome"><span className="soap-financial-welcome-icon"><SoapSmileIcon name="billing" /></span><p className="eyebrow">Patient financial workspace</p><h2>Every payment. A clearer picture.</h2><p>Select a patient to review recorded invoices, payments and balances.</p><SoapSmileEmptyState icon="patients"><p>Choose a patient from the finder.</p></SoapSmileEmptyState></div> : <>
        <button className="back-button" onClick={() => { setSelectedPatient(null); setError(null) }} type="button">Back to patients</button>
        <div className="profile-header"><div><p className="eyebrow">Patient file</p><h2>{[selectedPatient.first_name, selectedPatient.middle_name, selectedPatient.last_name].filter(Boolean).join(' ')}</h2><p className="profile-number">File number <strong>{selectedPatient.patient_number}</strong></p></div></div>
        {loadingBilling && <SoapSmileLoadingState>Loading billing history...</SoapSmileLoadingState>}
        {!loadingBilling && error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
        {!loadingBilling && !error && invoices.length > 0 && <SoapSmileInvoiceSummary invoice={invoices[0]} formatAmount={formatMoney} />}
        {!loadingBilling && !error && invoiceableVisits.length === 0 && invoices.length === 0 && <SoapSmileEmptyState icon="billing"><h2>No invoiceable visits</h2><p>Completed appointment visits and manual visits will appear here.</p></SoapSmileEmptyState>}
        {!loadingBilling && !error && invoiceableVisits.length > 0 && <section className="profile-card visit-history"><div className="section-heading"><div><p className="card-label">Billing</p><h3>Invoiceable visits</h3></div><span className="history-count">{invoiceableVisits.length} {invoiceableVisits.length === 1 ? 'visit' : 'visits'}</span></div><div className="visit-list">{invoiceableVisits.map((visit, index) => <VisitCard key={visit.id} clinicId={clinicId} visit={visit} isLatest={index === 0} clinicianLabel="Clinic clinician" prescriptions={[]} investigations={[]} invoices={invoices.filter((invoice) => invoice.visit_id === visit.id)} payments={payments} canBill billingOpen={billingVisit?.id === visit.id} clinicName={clinicName} patient={selectedPatient} onBill={() => setBillingVisit(visit)} onCancelBilling={() => setBillingVisit(null)} onInvoiceCreated={handleInvoiceCreated} onPaymentRecorded={handlePaymentRecorded} onViewReceipt={onViewReceipt} />)}</div></section>}
        {!loadingBilling && !error && unlinkedInvoices.length > 0 && <section className="profile-card visit-history"><div className="section-heading"><div><p className="card-label">Financial history</p><h3>Invoices without a visit link</h3></div></div><div className="visit-list">{unlinkedInvoices.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} payments={payments[invoice.id] ?? []} clinicName={clinicName} patient={selectedPatient} canRecordPayment onPaymentRecorded={handlePaymentRecorded} onViewReceipt={onViewReceipt} />)}</div></section>}
          </>}
        </section>
      </div>
    </div>
  )
}

function PatientRegistrationForm({ clinicId, onCancel, onRegistered }: { clinicId: string; onCancel: () => void; onRegistered: (patient: Patient) => void }) {
  const [form, setForm] = useState<PatientFormValues>(initialPatientForm)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useUnsavedWorkspace(JSON.stringify(form) !== JSON.stringify(initialPatientForm), submitting)
  const requestLock = useRef(false)
  const leave = () => { if (confirmWorkspaceLeave()) onCancel() }

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
    if (requestLock.current) return
    const firstName = form.first_name.trim()
    const lastName = form.last_name.trim()
    const email = form.email.trim()
    const ageInput = form.approximate_age_years.trim()
    const approximateAge = ageInput ? Number(ageInput) : null

    if (!firstName || !lastName) {
      setError('First name and last name are required.')
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

    requestLock.current = true
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
    requestLock.current = false
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
    <section className="registration-panel" aria-labelledby="registration-heading"><button type="button" className="back-button" disabled={submitting} onClick={leave}>← Back</button>
      <div className="registration-heading"><div><p className="eyebrow">Patient management</p><h2 id="registration-heading">Register New Patient</h2><p className="panel-copy">Enter the minimum details needed to create a patient file.</p><p className="generated-number-note">Patient file number will be generated automatically.</p></div></div>
      <form className="patient-form" onSubmit={handleSubmit}><fieldset disabled={submitting} style={{ display: 'contents' }}>
        <label>First name<input value={form.first_name} onChange={(event) => updateField('first_name', event.target.value)} autoComplete="given-name" required /></label>
        <label>Middle name<input value={form.middle_name} onChange={(event) => updateField('middle_name', event.target.value)} autoComplete="additional-name" /></label>
        <label>Last name<input value={form.last_name} onChange={(event) => updateField('last_name', event.target.value)} autoComplete="family-name" required /></label>
        <label>Gender<select value={form.gender} onChange={(event) => updateField('gender', event.target.value)}><option value="">Not specified</option><option value="Male">Male</option><option value="Female">Female</option></select></label>
        <label>Date of birth<input type="date" value={form.date_of_birth} onChange={(event) => updateField('date_of_birth', event.target.value)} /></label>
        <label>Approximate age (years)<input type="number" min="0" max="130" step="1" value={form.approximate_age_years} onChange={(event) => updateField('approximate_age_years', event.target.value)} placeholder="Use if DOB is unknown" /></label>
        <label>Phone<input type="tel" value={form.phone} onChange={(event) => updateField('phone', event.target.value)} autoComplete="tel" /></label>
        <label>Email<input type="email" value={form.email} onChange={(event) => updateField('email', event.target.value)} autoComplete="email" /></label>
        <label className="full-width">Address<input value={form.address} onChange={(event) => updateField('address', event.target.value)} autoComplete="street-address" /></label>
        </fieldset><div className="form-actions"><button className="button-secondary" onClick={leave} disabled={submitting} type="button">Cancel</button><button type="submit" disabled={submitting}>{submitting ? <><SoapSmileCompanion state="saving" />Saving patient...</> : 'Save patient'}</button></div>
      </form>
      {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    </section>
  )
}

function PatientTable({ patients, onSelect }: { patients: Patient[]; onSelect: (patient: Patient) => void }) {
  return (
    <div className="table-frame" tabIndex={0} role="region" aria-label="Patient directory">
      <table className="patient-table">
        <thead><tr><th>Patient</th><th>Age</th><th>Gender</th><th>Phone</th><th>Registered</th></tr></thead>
        <tbody>{patients.map((patient) => <tr className="patient-row" key={patient.id} onClick={() => onSelect(patient)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(patient) }} role="button" tabIndex={0} aria-label={`Open ${patient.first_name} ${patient.last_name}, file ${patient.patient_number}`}><td className="patient-identity-cell"><span className="patient-name-cell">{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</span><span className="file-number">{patient.patient_number}</span></td><td>{formatPatientAge(patient)}</td><td>{patient.gender || '-'}</td><td>{patient.phone || '-'}</td><td>{formatDate(patient.created_at)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

function PatientProfile({ clinicId, clinicName, clinicTimezone, userId, role, clinicianLabel, patient, initialEncounter, onViewAppointment, onBack, onUpdated, onViewReceipt, onPrintVisitSummary }: { clinicId: string; clinicName: string; clinicTimezone: string; userId: string; role: UserRole; clinicianLabel: string; patient: Patient; initialEncounter?: EncounterContext | null; onViewAppointment: (appointment: Appointment) => void; onBack: () => void; onUpdated: (patient: Patient) => void; onViewReceipt: ViewReceipt; onPrintVisitSummary: PrintVisitSummary }) {
  const [editing, setEditing] = useState(false)
  const [visits, setVisits] = useState<Visit[]>([])
  const [doctorNames, setDoctorNames] = useState<Record<string, string>>({})
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
  const [encounter, setEncounter] = useState<EncounterContext | null>(() => initialEncounter?.clinic_id === clinicId && initialEncounter.patient_id === patient.id ? initialEncounter : null)
  const [showAppointmentForm, setShowAppointmentForm] = useState(Boolean(initialEncounter))
  const [pendingEncounter, setPendingEncounter] = useState<EncounterContext | null>(null)
  const [encounterLoading, setEncounterLoading] = useState(true)
  const [encounterError, setEncounterError] = useState<string | null>(null)
  const [startingEncounter, setStartingEncounter] = useState(false)
  const [encounterRefresh, setEncounterRefresh] = useState(0)
  const encounterStartLock = useRef(false)
  const [bookedAppointment, setBookedAppointment] = useState<Appointment | null>(null)
  const [checkingIn, setCheckingIn] = useState(false)
  useUnsavedWorkspace(false, startingEncounter || checkingIn)
  const canViewFinance = role === 'admin' || role === 'receptionist'
  const canSchedule = ['admin', 'receptionist', 'doctor'].includes(role)

  useEffect(() => {
    let cancelled = false
    async function loadPending() {
      setEncounterLoading(true)
      if (!supabase) { setEncounterError('Supabase is not configured.'); setEncounterLoading(false); return }
      const result = await supabase.from('encounter_contexts').select('*').eq('clinic_id', clinicId).eq('patient_id', patient.id).eq('state', 'pending').maybeSingle()
      if (cancelled) return
      setEncounterLoading(false)
      if (result.error) { setEncounterError('We could not check appointment booking. Book Appointment will retry safely.'); return }
      setPendingEncounter(result.data as EncounterContext | null)
      setEncounterError(null)
    }
    void loadPending()
    return () => { cancelled = true }
  }, [clinicId, patient.id, encounterRefresh])

  async function startOperationalVisit() {
    if (encounterStartLock.current || !canSchedule) return
    // Keep the same context even if another staff member booked it meanwhile.
    // Booking will recover its actual appointment, rather than starting a new episode.
    const bookingContext = encounter ?? pendingEncounter
    if (bookingContext) {
      setEncounter(bookingContext)
      setShowAppointmentForm(true)
      setEncounterError(null)
      setBookedAppointment(null)
      return
    }
    encounterStartLock.current = true
    setStartingEncounter(true)
    setEncounterError(null)
    setBookedAppointment(null)
    try {
      const result = await startEncounterContext({ p_clinic_id: clinicId, p_patient_id: patient.id })
      if (result.error) throw new Error(result.error.message)
      if (!result.data) throw new Error('The encounter could not be confirmed. Retry Book Appointment.')
      setEncounter(result.data)
      setPendingEncounter(result.data)
      setShowAppointmentForm(true)
    } catch {
      setEncounterError('We could not prepare booking. Retry Book Appointment to continue.')
    } finally {
      encounterStartLock.current = false
      setStartingEncounter(false)
    }
  }

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
        pagedResult(() => supabase!.from('visits').select('*').eq('clinic_id', clinicId).eq('patient_id', patient.id).order('visit_date', { ascending: false }).order('id')),
        pagedResult(() => supabase!.from('prescriptions').select('*').eq('clinic_id', clinicId).eq('patient_id', patient.id).order('created_at', { ascending: true }).order('id')),
        pagedResult(() => supabase!.from('investigations').select('*').eq('clinic_id', clinicId).eq('patient_id', patient.id).order('created_at', { ascending: true }).order('id')),
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
      const historicalDoctorNames = await loadClinicianNames(visitRows.map((visit) => visit.doctor_id))
      if (cancelled) return
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
      setDoctorNames(historicalDoctorNames)
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

  async function checkInBookedAppointment() {
    if (!supabase || !bookedAppointment || checkingIn) return
    setCheckingIn(true)
    setEncounterError(null)
    const { data, error } = await supabase.from('appointments').update({ status: 'arrived' } as never)
      .eq('clinic_id', clinicId).eq('id', bookedAppointment.id).in('status', ['scheduled', 'confirmed']).select('*').single()
    setCheckingIn(false)
    if (error || !data) { setEncounterError('We could not check in this appointment. Open the appointment to review its current status.'); return }
    setBookedAppointment(data as Appointment)
  }
  if (showAppointmentForm && encounter) return <AppointmentForm key={encounter.id} clinicId={clinicId} timezone={clinicTimezone} encounter={encounter} patient={patient} onCancel={() => { setShowAppointmentForm(false); setEncounterRefresh((version) => version + 1) }} onCreated={(appointment) => { setShowAppointmentForm(false); setEncounter(null); setPendingEncounter(null); setEncounterRefresh((version) => version + 1); setBookedAppointment(appointment) }} />
  if (billingVisit && canViewFinance) return <InvoiceForm clinicId={clinicId} patient={patient} visit={billingVisit} onCancel={() => setBillingVisit(null)} onCreated={handleInvoiceCreated} />
  if (bookedAppointment) return <section className="registration-panel"><h2>Appointment booked</h2><p>{patient.first_name} {patient.last_name} · File {patient.patient_number}</p><p>{formatDate(bookedAppointment.appointment_date)} · {formatTime(bookedAppointment.start_time)} · {formatStatus(bookedAppointment.status)}</p><div className="form-actions"><button type="button" onClick={() => onViewAppointment(bookedAppointment)}>View Appointment</button><button type="button" className="button-secondary" onClick={() => setBookedAppointment(null)}>View Patient</button>{canSchedule && bookedAppointment.appointment_date === todayInputValue(clinicTimezone) && ['scheduled', 'confirmed'].includes(bookedAppointment.status) && <button type="button" className="button-secondary" disabled={checkingIn} onClick={() => void checkInBookedAppointment()}>{checkingIn ? 'Checking in...' : 'Check In'}</button>}</div>{encounterError && <SoapSmileFeedback tone="error">{encounterError}</SoapSmileFeedback>}</section>

  return (
    <section className="profile-page">
      <button className="back-button" onClick={onBack} type="button">Back to patients</button>
      {!editing ? <>
        <div className="profile-header"><div><p className="eyebrow">Patient file</p><h2>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</h2><p className="profile-number">File number <strong>{patient.patient_number}</strong></p></div><div className="profile-actions"><button className="button-secondary profile-secondary-action" onClick={() => setEditing(true)} type="button">Edit details</button>{canSchedule && <button className="primary-action" disabled={startingEncounter || showAppointmentForm || encounterLoading} onClick={() => void startOperationalVisit()} type="button">{startingEncounter ? 'Preparing booking...' : 'Book Appointment'}</button>}{(role === 'admin' || role === 'doctor') && <details className="queue-action-menu"><summary>More Actions</summary><div><p>For clinical care recorded without an appointment.</p><button type="button" className="button-secondary" onClick={() => { setVisitSuccess(null); setShowVisitForm(true) }}>Record Standalone Clinical Visit</button></div></details>}</div></div>
        <div className="profile-grid"><section className="profile-card"><p className="card-label">Personal details</p><dl className="detail-list"><DetailItem label="Full name" value={[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} /><DetailItem label="Gender" value={patient.gender} /><DetailItem label="Date of birth" value={formatDate(patient.date_of_birth)} /><DetailItem label="Age" value={formatPatientAge(patient)} /><DetailItem label="Registered" value={formatDate(patient.created_at)} /></dl></section><section className="profile-card"><p className="card-label">Contact details</p><dl className="detail-list"><DetailItem label="Phone" value={patient.phone} /><DetailItem label="Email" value={patient.email} /><DetailItem label="Address" value={patient.address} /></dl></section></div>
        <PatientClinicalProfile key={`${clinicId}:${patient.id}:${userId}:${role}`} clinicId={clinicId} patient={patient} role={role} onUpdated={onUpdated} />
        {encounterError && <SoapSmileFeedback tone="error">{encounterError}</SoapSmileFeedback>}
        {role === 'receptionist' && <p className="role-note">A doctor or clinic administrator must be signed in to create a clinical visit.</p>}
        {showVisitForm && <NewVisitForm clinicId={clinicId} patientId={patient.id} doctorId={userId} clinicianLabel={clinicianLabel} onCancel={() => setShowVisitForm(false)} onCreated={handleVisitCreated} />}
        {visitSuccess && <SoapSmileFeedback tone="success">{visitSuccess}</SoapSmileFeedback>}
        <section className="profile-card visit-history"><div className="section-heading"><div><p className="card-label">Visit history</p><h3>Clinical encounters</h3></div><span className="history-count">{visits.length} {visits.length === 1 ? 'visit' : 'visits'}</span></div>
          {visitLoading && <SoapSmileLoadingState>Loading visit history...</SoapSmileLoadingState>}
          {!visitLoading && visitError && <SoapSmileFeedback tone="error">{visitError}</SoapSmileFeedback>}
          {!visitLoading && !visitError && visits.length === 0 && <div className="empty-history"><h4>No visits recorded</h4><p>New clinical encounters will appear here without replacing previous records.</p></div>}
          {!visitLoading && !visitError && visits.length > 0 && <div className="visit-list">{visits.map((visit, index) => <VisitCard key={visit.id} clinicId={clinicId} visit={visit} isLatest={index === 0} clinicianLabel={doctorNames[visit.doctor_id] ?? (visit.doctor_id === userId ? clinicianLabel : 'Clinic clinician')} prescriptions={prescriptions[visit.id] ?? []} investigations={investigations[visit.id] ?? []} invoices={invoices.filter((invoice) => invoice.visit_id === visit.id)} payments={payments} canBill={role === 'admin' || role === 'receptionist'} billingOpen={billingVisit?.id === visit.id} clinicName={clinicName} patient={patient} userId={userId} role={role} onBill={() => setBillingVisit(visit)} onCancelBilling={() => setBillingVisit(null)} onInvoiceCreated={handleInvoiceCreated} onPaymentRecorded={handlePaymentRecorded} onViewReceipt={onViewReceipt} onPrintVisitSummary={onPrintVisitSummary} />)}</div>}
        </section>
        {canViewFinance && !visitLoading && !visitError && unlinkedInvoices.length > 0 && <section className="profile-card visit-history"><div className="section-heading"><div><p className="card-label">Financial history</p><h3>Invoices without a visit link</h3></div></div><div className="visit-list">{unlinkedInvoices.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} payments={payments[invoice.id] ?? []} clinicName={clinicName} patient={patient} canRecordPayment={role === 'admin' || role === 'receptionist'} onPaymentRecorded={handlePaymentRecorded} onViewReceipt={onViewReceipt} />)}</div></section>}
      </> : <PatientEditForm clinicId={clinicId} patient={patient} onCancel={() => setEditing(false)} onSaved={(updatedPatient) => { setEditing(false); onUpdated(updatedPatient) }} />}
    </section>
  )
}

const clinicalProfileFields: Array<{ field: ClinicalProfileField; label: string }> = [
  { field: 'allergies', label: 'Allergies' },
  { field: 'current_medications', label: 'Current medications' },
  { field: 'medical_history', label: 'Medical history' },
  { field: 'previous_surgery', label: 'Surgical history' },
  { field: 'family_history', label: 'Family history' },
  { field: 'dental_history', label: 'Dental history' },
  { field: 'relevant_habits', label: 'Habits' },
  { field: 'pregnancy_status', label: 'Pregnancy information' },
]

function ClinicalProfileValues({ profile }: { profile: Pick<Patient, ClinicalProfileField> }) {
  return <dl className="detail-list">{clinicalProfileFields.map(({ field, label }) => <div key={field}><dt>{label}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{profile[field]?.trim() ? profile[field] : 'Not recorded'}</dd></div>)}</dl>
}

function PatientClinicalProfile({ clinicId, patient, role, onUpdated }: { clinicId: string; patient: Patient; role: UserRole; onUpdated: (patient: Patient) => void }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Record<ClinicalProfileField, string>>(() => Object.fromEntries(clinicalProfileFields.map(({ field }) => [field, patient[field] ?? ''])) as Record<ClinicalProfileField, string>)
  const [expectedVersion, setExpectedVersion] = useState(patient.clinical_profile_version)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<PatientClinicalProfileVersion[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyLimit, setHistoryLimit] = useState(50)
  const [hasMoreHistory, setHasMoreHistory] = useState(false)
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const mounted = useRef(true)
  const saveLock = useRef(false)
  const canRecord = ['admin', 'doctor', 'receptionist'].includes(role)

  useUnsavedWorkspace(editing && clinicalProfileFields.some(({ field }) => form[field] !== (patient[field] ?? '')), saving)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!historyOpen || !canRecord) return
    let cancelled = false
    async function loadHistory() {
      setHistoryLoading(true)
      setHistoryError(null)
      if (!supabase) { setHistoryError('Supabase is not configured.'); setHistoryLoading(false); return }
      const result = await pagedResult(() => supabase!.from('patient_clinical_profile_versions').select('*')
        .eq('clinic_id', clinicId).eq('patient_id', patient.id).order('version_number', { ascending: false }).order('id'))
      if (cancelled) return
      setHistoryLoading(false)
      if (result.error) { setHistory([]); setHistoryError('We could not load profile history.'); return }
      const rows = (result.data ?? []) as PatientClinicalProfileVersion[]
      setHistory(rows.slice(0, historyLimit))
      setHasMoreHistory(rows.length > historyLimit)
    }
    void loadHistory()
    return () => { cancelled = true }
  }, [canRecord, clinicId, patient.id, patient.clinical_profile_version, historyOpen, historyLimit, historyRefresh])

  function beginEdit() {
    setForm(Object.fromEntries(clinicalProfileFields.map(({ field }) => [field, patient[field] ?? ''])) as Record<ClinicalProfileField, string>)
    setExpectedVersion(patient.clinical_profile_version)
    setError(null)
    setConflict(false)
    setSuccess(null)
    setEditing(true)
  }

  async function reloadLatest() {
    if (!supabase || saveLock.current) return
    saveLock.current = true
    setSaving(true)
    try {
      const { data, error: reloadError } = await supabase.from('patients').select('*').eq('clinic_id', clinicId).eq('id', patient.id).single()
      if (!mounted.current) return
      if (reloadError || !data) { setError('We could not reload the clinical profile. Please try again.'); return }
      onUpdated(data as Patient)
      setEditing(false)
      setConflict(false)
      setError(null)
      setSuccess('Latest clinical profile loaded. Review it before editing again.')
      setHistoryRefresh((value) => value + 1)
    } catch {
      if (mounted.current) setError('We could not reload the clinical profile. Please try again.')
    } finally {
      saveLock.current = false
      if (mounted.current) setSaving(false)
    }
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canRecord || saveLock.current || conflict) return
    if (!supabase) { setError('Supabase is not configured.'); return }
    saveLock.current = true
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await updatePatientClinicalProfile({
        p_clinic_id: clinicId, p_patient_id: patient.id, p_expected_version: expectedVersion,
        p_allergies: form.allergies, p_current_medications: form.current_medications,
        p_medical_history: form.medical_history, p_previous_surgery: form.previous_surgery,
        p_family_history: form.family_history, p_dental_history: form.dental_history,
        p_relevant_habits: form.relevant_habits, p_pregnancy_status: form.pregnancy_status,
      })
      if (!mounted.current) return
      if (result.error) {
        if (result.error.code === 'P0022') {
          setConflict(true)
          setError('Another staff member updated the clinical profile. Reload and review the latest profile before saving. Reloading discards these unsaved changes.')
        } else {
          setError('We could not save the clinical profile. Your changes are still in the editor.')
        }
        return
      }
      if (!result.data) { setError('The saved clinical profile could not be confirmed. Reload the latest profile before editing again.'); setConflict(true); return }
      const latest = await supabase.from('patients').select('*').eq('clinic_id', clinicId).eq('id', patient.id).single()
      if (!mounted.current) return
      onUpdated((latest.data ?? result.data) as Patient)
      setEditing(false)
      setSuccess(latest.error ? 'Clinical profile saved. The latest profile could not be reloaded; refresh before editing again.' : 'Clinical profile saved.')
      setHistoryRefresh((value) => value + 1)
    } catch {
      if (mounted.current) {
        setConflict(true)
        setError('The save could not be confirmed. Reload and review the latest profile before trying again.')
      }
    } finally {
      saveLock.current = false
      if (mounted.current) setSaving(false)
    }
  }

  return <section className="profile-card visit-history" aria-label="Patient clinical background">
    <div className="section-heading"><h3>Current Clinical Profile</h3>{canRecord && !editing && <button type="button" className="button-secondary inline-button" onClick={beginEdit}>Edit Clinical Profile</button>}</div>
    {!editing ? <ClinicalProfileValues profile={patient} /> : <form className="patient-form" onSubmit={(event) => void saveProfile(event)}>
      {clinicalProfileFields.map(({ field, label }) => <label key={field} className="full-width">{label}<textarea value={form[field]} disabled={saving} rows={2} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} /></label>)}
      <div className="form-actions"><button type="button" className="button-secondary" disabled={saving} onClick={() => { if (!confirmWorkspaceLeave()) return; setEditing(false); setError(null); setConflict(false) }}>Cancel</button><button type="submit" disabled={saving || conflict}>{saving ? 'Saving...' : 'Save clinical profile'}</button></div>
    </form>}
    {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    {conflict && <button type="button" className="button-secondary inline-button" disabled={saving} onClick={() => void reloadLatest()}>Reload latest profile</button>}
    {success && <SoapSmileFeedback tone="success">{success}</SoapSmileFeedback>}
    {canRecord && <details open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
      <summary>Profile History</summary>
      {historyOpen && <>
        <p>Previous clinical background is preserved. Expand a version to review its recorded state.</p>
        {historyLoading && <SoapSmileLoadingState>Loading profile history...</SoapSmileLoadingState>}
        {historyError && <><SoapSmileFeedback tone="error">{historyError}</SoapSmileFeedback><button type="button" className="button-secondary inline-button" onClick={() => setHistoryRefresh((value) => value + 1)}>Retry history</button></>}
        {!historyLoading && !historyError && history.length === 0 && <p>No profile history available.</p>}
        {!historyError && history.map((version) => <details key={version.id} className="profile-card">
          <summary>Version {version.version_number} · {version.origin === 'legacy_baseline' ? 'Legacy baseline captured' : 'Recorded'} {formatDateTime(version.recorded_at)} · {version.origin === 'legacy_baseline' ? 'Original actor unknown' : version.actor_display_name || `Staff member (${version.recorded_by})`}</summary>
          {version.origin === 'legacy_baseline' ? <p>Captured when version history began. The original recording date and actor are unknown.</p> : <p>{version.origin === 'created' ? 'Initial profile' : 'Changed fields'}: {version.changed_fields.map((field) => clinicalProfileFields.find((item) => item.field === field)?.label ?? field).join(', ') || 'Not recorded'}</p>}
          <ClinicalProfileValues profile={version} />
        </details>)}
        {!historyLoading && !historyError && hasMoreHistory && <button type="button" className="button-secondary inline-button" onClick={() => setHistoryLimit((value) => value + 50)}>Show older versions</button>}
      </>}
    </details>}
  </section>
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

  useUnsavedWorkspace(JSON.stringify(form) !== JSON.stringify(initialVisitForm), submitting)
  const leave = () => { if (confirmWorkspaceLeave()) onCancel() }

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
      <div className="registration-heading"><p className="eyebrow">Clinical encounter</p><h2 id="new-visit-heading">Record Standalone Clinical Visit</h2><p className="panel-copy">Record a separate clinical encounter as {clinicianLabel}. This does not book or link an appointment. For scheduled care, use Start New Visit instead. Previous visits remain unchanged.</p></div>
      <form className="patient-form" onSubmit={handleSubmit}>
        <label>Visit date and time<input type="datetime-local" value={form.visit_date} onChange={(event) => updateField('visit_date', event.target.value)} /></label>
        <label>Chief complaint<textarea value={form.chief_complaint} onChange={(event) => updateField('chief_complaint', event.target.value)} rows={3} /></label>
        <label>Assessment<textarea value={form.assessment} onChange={(event) => updateField('assessment', event.target.value)} rows={3} /></label>
        <label>Treatment plan<textarea value={form.treatment_plan} onChange={(event) => updateField('treatment_plan', event.target.value)} rows={3} /></label>
        <label className="full-width">Clinical notes<textarea value={form.clinical_notes} onChange={(event) => updateField('clinical_notes', event.target.value)} rows={4} /></label>
        <div className="form-actions"><button className="button-secondary" onClick={leave} disabled={submitting} type="button">Cancel</button><button type="submit" disabled={submitting}>{submitting ? <><SoapSmileCompanion state="saving" />Saving visit...</> : 'Save visit'}</button></div>
      </form>
      {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    </section>
  )
}

function InvoiceForm({ clinicId, patient, visit, onCancel, onCreated }: { clinicId: string; patient: Patient; visit: Visit; onCancel: () => void; onCreated: (invoice: Invoice) => void }) {
  const [total, setTotal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const requestLock = useRef(false)
  const [needsReview, setNeedsReview] = useState(false)
  useUnsavedWorkspace(Boolean(total) && !needsReview, submitting)
  const leave = () => { if (confirmWorkspaceLeave()) onCancel() }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (requestLock.current || needsReview) return
    const amount = Number(total)
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter an invoice total greater than zero.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }
    requestLock.current = true
    setSubmitting(true)
    setError(null)
    try {
      const { data, error: createError } = await supabase.rpc('create_invoice', {
        p_clinic_id: clinicId,
        p_patient_id: patient.id,
        p_visit_id: visit.id,
        p_total: amount,
      } as never)
      if (createError || !data) {
        setNeedsReview(true)
        setError('The invoice could not be confirmed. Return to the patient billing history and refresh before trying again.')
        return
      }
      onCreated(data as Invoice)
    } catch {
      setNeedsReview(true)
      setError('The invoice could not be confirmed. Return to the patient billing history before retrying.')
    } finally {
      requestLock.current = false
      setSubmitting(false)
    }
  }

  return <section className="registration-panel billing-form-panel" aria-labelledby="invoice-heading"><button type="button" className="back-button" disabled={submitting} onClick={leave}>← Back</button><div className="registration-heading"><p className="eyebrow">Billing</p><h2 id="invoice-heading">Create invoice</h2><p className="panel-copy">{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} · Visit {formatDateTime(visit.visit_date)}</p></div><form className="patient-form" onSubmit={handleSubmit}><label>Invoice total<input disabled={submitting || needsReview} type="number" min="0.01" step="0.01" value={total} onChange={(event) => setTotal(event.target.value)} required /></label><div className="form-actions"><button className="button-secondary" onClick={leave} disabled={submitting} type="button">Cancel</button><button type="submit" disabled={submitting || needsReview}>{submitting ? 'Creating invoice...' : 'Create invoice'}</button></div></form>{error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}</section>
}

function VisitCard({ clinicId, visit: originalVisit, isLatest, clinicianLabel, prescriptions, investigations, invoices, payments, canBill, billingOpen, clinicName, patient, userId, role, onBill, onCancelBilling, onInvoiceCreated, onPaymentRecorded, onViewReceipt, onPrintVisitSummary }: { clinicId: string; visit: Visit; isLatest: boolean; clinicianLabel: string; prescriptions: Prescription[]; investigations: Investigation[]; invoices: Invoice[]; payments: Record<string, Payment[]>; canBill: boolean; billingOpen: boolean; clinicName: string; patient: Patient; userId?: string; role?: UserRole; onBill: () => void; onCancelBilling: () => void; onInvoiceCreated: (invoice: Invoice) => void; onPaymentRecorded: (invoice: Invoice, payment: Payment) => void; onViewReceipt: ViewReceipt; onPrintVisitSummary?: PrintVisitSummary }) {
  const [appointmentCompleted,setAppointmentCompleted] = useState(false)
  useEffect(() => {
    let cancelled=false
    if (originalVisit.appointment_id && supabase) void supabase.from('appointments').select('status').eq('clinic_id',clinicId).eq('id',originalVisit.appointment_id).single().then((result) => {
      const row=result.data as Pick<Appointment,'status'> | null
      if (!cancelled) setAppointmentCompleted(!result.error && row?.status==='completed')
    })
    return () => { cancelled=true }
  },[clinicId,originalVisit.appointment_id])
  const correctionState = useCorrections(clinicId,originalVisit.id)
  const visit = effectiveRecord(originalVisit,correctionState.rows,'visit')!
  const related = (kind: 'visit' | 'prescription' | 'investigation', id: string) => correctionState.rows.filter((row) => row.kind===kind && row.record_id===id)
  const currentPrescriptions = prescriptions.map((row) => effectiveRecord(row,correctionState.rows,'prescription')).filter((row): row is Prescription => Boolean(row))
  const currentInvestigations = investigations.map((row) => effectiveRecord(row,correctionState.rows,'investigation')).filter((row): row is Investigation => Boolean(row))
  const [lifecycle, setLifecycle] = useState<StandaloneVisitLifecycle | null>(null)
  const [procedureCount, setProcedureCount] = useState<number | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  useUnsavedWorkspace(false, finalizing)
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (visit.appointment_id || !supabase) return
      const result = await supabase.from('standalone_visit_lifecycle').select('*').eq('clinic_id', clinicId).eq('visit_id', visit.id).single()
      if (cancelled) return
      if (result.error) setLifecycleError('Standalone lifecycle could not be verified. Refresh the patient file.')
      else { setLifecycle(result.data as StandaloneVisitLifecycle); setLifecycleError(null) }
    }
    void load()
    return () => { cancelled = true }
  }, [clinicId, visit.id, visit.appointment_id])
  async function finalizeVisit() {
    if (!supabase || finalizing || !confirmWorkspaceLeave()) return
    if (!procedureCount) { setLifecycleError('Record at least one procedure or Consultation Only before closing this visit.'); return }
    setFinalizing(true)
    setLifecycleError(null)
    try {
      const result = await supabase.rpc('finalize_standalone_visit', { p_visit_id: visit.id } as never)
      if (result.error) throw result.error
      setLifecycle(result.data as StandaloneVisitLifecycle)
    } catch (failure) { setLifecycleError((failure as { message?: string }).message || 'Finalization could not be confirmed. Refresh the patient file before retrying.') }
    finally { setFinalizing(false) }
  }
  const standaloneSaved = !visit.appointment_id && lifecycle?.state === 'saved'
  const standaloneFinalized = !visit.appointment_id && lifecycle?.state === 'finalized'
  const canFinalize = standaloneSaved && (role === 'admin' || (role === 'doctor' && visit.doctor_id === userId))
  const canViewDentalChart = (role === 'admin' || role === 'doctor') && Boolean(userId)
  const canAddDentalEntries = role === 'admin' || (role === 'doctor' && visit.doctor_id === userId)

  return (
    <article className={`visit-card${isLatest ? ' latest' : ''}`}>
      <div className="visit-card-header"><div><p className="visit-date">{formatDateTime(visit.visit_date)}</p><p className="visit-clinician">Clinical author / assigned clinician: {clinicianLabel}</p></div><div className="visit-card-actions">{isLatest && <span className="latest-badge">Latest</span>}{onPrintVisitSummary && <button className="button-secondary inline-button" onClick={() => onPrintVisitSummary(patient, visit, clinicianLabel, prescriptions, investigations)} type="button">Print Visit Summary</button>}</div></div>
      <div className="visit-fields">{correctionState.loading ? <p>Verifying effective clinical record...</p> : correctionState.error ? <p role="alert">{correctionState.error}</p> : <>{latestCorrection(correctionState.rows,'visit',visit.id) && <p>Amended narrative - original retained in correction history</p>}{visit.chief_complaint && <div><span>Chief complaint</span><p>{visit.chief_complaint}</p></div>}{visit.assessment && <div><span>Assessment</span><p>{visit.assessment}</p></div>}{visit.treatment_plan && <div><span>Treatment plan</span><p>{visit.treatment_plan}</p></div>}{visit.clinical_notes && <div><span>Clinical notes</span><p>{visit.clinical_notes}</p></div>}</>}</div>
      {!visit.appointment_id && <div className="form-actions"><span>{lifecycle ? lifecycle.state === 'saved' ? 'Saved — unfinished' : 'Finalized' : 'Verifying standalone lifecycle...'}</span>{lifecycle?.legacy_baseline && <span>Historical finalization actor/time unknown</span>}{canFinalize && <button type="button" disabled={finalizing || !procedureCount} onClick={() => void finalizeVisit()}>{finalizing ? 'Finalizing...' : 'Finalize standalone visit'}</button>}{lifecycleError && <SoapSmileFeedback tone="error">{lifecycleError}</SoapSmileFeedback>}</div>}
      <VisitProcedures key={visit.id + ':' + (lifecycle?.state ?? 'appointment')} visit={visit} userId={userId} role={role} canCreate={standaloneSaved && canAddDentalEntries} disabled={finalizing} onCount={setProcedureCount} />
      {!correctionState.loading && !correctionState.error && <>
        {(!visit.appointment_id || appointmentCompleted) && <ClinicalCorrectionAction kind="visit" record={originalVisit} rows={correctionState.rows} authorId={visit.doctor_id} userId={userId} role={role} onSaved={correctionsChanged} />}
        <CorrectionHistory original={originalVisit} rows={related('visit',visit.id)} />
        <VisitRecordsSummary prescriptions={currentPrescriptions} investigations={currentInvestigations} />
        <details><summary>Prescription / investigation actions and history</summary>
          {prescriptions.map((row) => <article key={row.id}><strong>{row.medicine} - {latestCorrection(correctionState.rows,'prescription',row.id)?.action === 'withdraw' ? 'Withdrawn' : latestCorrection(correctionState.rows,'prescription',row.id) ? 'Replaced' : 'Active'}</strong><ClinicalCorrectionAction kind="prescription" record={row} rows={correctionState.rows} authorId={visit.doctor_id} userId={userId} role={role} onSaved={correctionsChanged} /><CorrectionHistory original={row} rows={related('prescription',row.id)} /></article>)}
          {investigations.map((row) => <article key={row.id}><strong>{row.investigation_type} - {latestCorrection(correctionState.rows,'investigation',row.id)?.action === 'withdraw' ? 'Withdrawn' : latestCorrection(correctionState.rows,'investigation',row.id) ? 'Replaced' : 'Active'}</strong><ClinicalCorrectionAction kind="investigation" record={row} rows={correctionState.rows} authorId={visit.doctor_id} userId={userId} role={role} onSaved={correctionsChanged} /><CorrectionHistory original={row} rows={related('investigation',row.id)} /></article>)}
        </details>
      </>}
      {canViewDentalChart && userId && <DentalChart role={role} clinicId={clinicId} visit={visit} userId={userId} canCreate={canAddDentalEntries && standaloneSaved && !finalizing} />}
      {canBill && <div className="visit-invoices"><div className="section-heading"><div><span>Financial history</span><h4>Invoices</h4></div>{invoices.length === 0 && (Boolean(visit.appointment_id) || standaloneFinalized) && <button className="button-secondary inline-button" onClick={onBill} type="button">Create invoice</button>}</div>{invoices.length === 0 ? <SoapSmileEmptyState><p>No invoice for this visit.</p></SoapSmileEmptyState> : invoices.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} payments={payments[invoice.id] ?? []} clinicName={clinicName} patient={patient} canRecordPayment={canBill} onPaymentRecorded={onPaymentRecorded} onViewReceipt={onViewReceipt} />)}{billingOpen && (Boolean(visit.appointment_id) || standaloneFinalized) && <InvoiceForm clinicId={clinicId} patient={patient} visit={visit} onCancel={onCancelBilling} onCreated={onInvoiceCreated} />}</div>}
    </article>
  )
}

function InvoiceCard({ invoice, payments, clinicName, patient, canRecordPayment, onPaymentRecorded, onViewReceipt }: { invoice: Invoice; payments: Payment[]; clinicName: string; patient: Patient; canRecordPayment: boolean; onPaymentRecorded: (invoice: Invoice, payment: Payment) => void; onViewReceipt: ViewReceipt }) {
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

  return <section className="invoice-card"><div className="invoice-header"><div><span>Invoice</span><strong>{invoice.invoice_number}</strong><time dateTime={invoice.created_at}>{formatDateTime(invoice.created_at)}</time></div><span className={`invoice-status invoice-${invoice.status}`}>{formatStatus(invoice.status)}</span></div><div className="invoice-totals"><div><span>Total</span><strong>{formatMoney(invoice.total, invoice.currency)}</strong></div><div><span>Paid</span><strong>{formatMoney(invoice.amount_paid, invoice.currency)}</strong></div><div><span>Balance</span><strong>{formatMoney(invoice.balance, invoice.currency)}</strong></div></div>{payments.length > 0 && <div className="payment-list"><span>Payments</span>{payments.map((payment) => <div className="payment-history-row" key={payment.id}><p>{formatMoney(payment.amount, invoice.currency)} · {formatStatus(payment.payment_method)}{payment.reference ? ` · ${payment.reference}` : ''} · {formatDateTime(payment.payment_date)}</p><button className="button-secondary inline-button" onClick={() => onViewReceipt(patient, invoice, payment)} type="button">View Receipt</button></div>)}</div>}{canRecordInvoicePayment && <PaymentForm invoice={invoice} onRecorded={handlePaymentRecorded} />}{receiptPayment && <PaymentConfirmation clinicName={clinicName} patient={patient} invoice={invoice} payment={receiptPayment} onViewReceipt={() => onViewReceipt(patient, invoice, receiptPayment)} />}{error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}</section>
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

  return <form className="payment-form" onSubmit={handleSubmit}><input type="number" min="0.01" step="0.01" aria-label="Amount" placeholder="Amount" value={amount} onChange={(event) => setAmount(event.target.value)} required /><select aria-label="Payment method" value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>{methods.map((paymentMethod) => <option key={paymentMethod} value={paymentMethod}>{formatStatus(paymentMethod)}</option>)}</select><input aria-label="Reference (optional)" placeholder="Reference (optional)" value={reference} onChange={(event) => setReference(event.target.value)} /><button type="submit" disabled={submitting}>{submitting ? <><SoapSmileCompanion state="payment" />Processing payment...</> : invoice.status === 'partially_paid' ? 'Record Another Payment' : 'Record Payment'}</button>{error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}</form>
}

function PaymentConfirmation({ clinicName, patient, invoice, payment, onViewReceipt }: { clinicName: string; patient: Patient; invoice: Invoice; payment: Payment; onViewReceipt: () => void }) {
  return <section className="receipt-panel"><div><span>Payment recorded</span><strong>{clinicName}</strong></div><p>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} · File {patient.patient_number}</p><p>Invoice {invoice.invoice_number} · {formatMoney(payment.amount, invoice.currency)} via {formatStatus(payment.payment_method)}</p><p>{formatDateTime(payment.payment_date)} · Paid {formatMoney(invoice.amount_paid, invoice.currency)} · Current balance {formatMoney(invoice.balance, invoice.currency)}</p><button className="button-secondary inline-button" onClick={onViewReceipt} type="button">View Receipt</button></section>
}

function ReportPrintHost({ document, onDone }: { document: Extract<PrintableDocument, { type: 'report' }>; onDone: (value: null) => void }) {
  useEffect(() => {
    let secondFrame = 0
    const finished = () => onDone(null)
    window.addEventListener('afterprint', finished)
    // React has committed the selected report. Allow layout to settle before
    // native print preview switches to the isolated print stylesheet.
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => window.print())
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
      window.removeEventListener('afterprint', finished)
    }
  }, [document, onDone])
  return <div className="report-print-host" aria-hidden="true"><ReportPrintDocument clinic={document.clinic} data={document.data} startDate={document.startDate} endDate={document.endDate} generatedAt={document.generatedAt} view={document.view} /></div>
}

function PrintableDocumentPreview({ document, onClose }: { document: Exclude<PrintableDocument, { type: 'report' }>; onClose: () => void }) {
  const title = document.type === 'receipt' ? 'Payment receipt' : 'Clinical visit summary'

  return <div className="print-preview-overlay" role="dialog" aria-modal="true" aria-label={title}>
    <div className="print-preview-toolbar"><strong>{title}</strong><div><button className="button-secondary" onClick={onClose} type="button">Close</button><button className="primary-action" onClick={() => window.print()} type="button">Print / Reprint</button></div></div>
    {document.type === 'receipt'
      ? <PaymentReceiptDocument clinic={document.clinic} patient={document.patient} invoice={document.invoice} payment={document.payment} />
      : <VisitSummaryDocument clinic={document.clinic} patient={document.patient} visit={document.visit} clinicianName={document.clinicianName} prescriptions={document.prescriptions} investigations={document.investigations} standaloneState={document.standaloneState} />}
  </div>
}

function safeClinicLogoUrl(value: string | null | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function PrintableClinicHeader({ clinic }: { clinic: Clinic }) {
  const logoUrl = safeClinicLogoUrl(clinic.logo_url)
  const contactDetails = [
    clinic.address,
    clinic.phone ? `Phone: ${clinic.phone}` : null,
    clinic.email,
    clinic.website,
  ].filter(Boolean)

  return <header className="print-clinic-header">
    {logoUrl && <img src={logoUrl} alt={`${clinic.name} logo`} referrerPolicy="no-referrer" />}
    <div><h2>{clinic.name}</h2>{clinic.tagline && <p>{clinic.tagline}</p>}{contactDetails.length > 0 && <p>{contactDetails.join(' · ')}</p>}</div>
  </header>
}

function PaymentReceiptDocument({ clinic, patient, invoice, payment }: { clinic: Clinic; patient: Patient; invoice: Invoice; payment: Payment }) {
  return <article className="print-document print-receipt">
    <PrintableClinicHeader clinic={clinic} />
    <div className="print-document-heading"><div><p>Financial record</p><h1>PAYMENT RECEIPT</h1></div><div><span>Invoice number</span><strong>{invoice.invoice_number}</strong></div></div>
    <div className="print-metadata-grid">
      <div><span>Patient</span><strong>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</strong><small>Patient number {patient.patient_number}</small></div>
      <div><span>Payment date</span><strong>{formatDateTime(payment.payment_date)}</strong></div>
    </div>
    <div className="print-financial-table">
      <div><span>Invoice total</span><strong>{formatMoney(invoice.total, invoice.currency)}</strong></div>
      <div className="print-payment-total"><span>This payment</span><strong>{formatMoney(payment.amount, invoice.currency)}</strong></div>
      <div><span>Payment method</span><strong>{formatStatus(payment.payment_method)}</strong></div>
      {payment.reference && <div><span>Payment reference</span><strong>{payment.reference}</strong></div>}
    </div>
    <footer className="print-document-footer">All amounts are in {invoice.currency}.</footer>
  </article>
}

function ReportDataTable({ title, headers, rows, emptyMessage }: { title: string; headers: string[]; rows: string[][]; emptyMessage: string }) {
  return <section className="print-report-section">
    <h2>{title}</h2>
    <table className="print-report-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>
      {rows.length > 0 ? rows.map((row, rowIndex) => <tr key={`${title}-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${title}-${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>) : <tr><td colSpan={headers.length}>{emptyMessage}</td></tr>}
    </tbody></table>
  </section>
}

function ReportPrintDocument({ clinic, data, startDate, endDate, generatedAt, view }: { clinic: Clinic; data: ReportsData; startDate: string; endDate: string; generatedAt: string; view: ReportView }) {
  const appointmentsByStatus = data.appointments.reduce<Record<string, number>>((counts, appointment) => {
    counts[appointment.status] = (counts[appointment.status] ?? 0) + 1
    return counts
  }, {})
  const paymentMethodRows = Object.entries(data.paymentsByMethod)
    .sort(([first], [second]) => first.localeCompare(second))
    .flatMap(([method, currencies]) => Object.entries(currencies)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([currency, amount]) => [formatStatus(method), currency, formatMoney(amount, currency)]))
  const paymentTotals = Object.entries(data.paymentsByCurrency)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([currency, amount]) => formatMoney(amount, currency))
  const generatedDate = new Intl.DateTimeFormat(undefined, { timeZone: clinic.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(generatedAt)) + ' (' + clinic.timezone + ')'

  return <article className="print-document print-report">
    <p className="print-soapsmile">SoapSmile</p>
    <PrintableClinicHeader clinic={clinic} />
    <div className="print-document-heading"><div><h1>{view === 'procedures' ? 'PROCEDURE ACTIVITY REPORT' : 'CLINIC OPERATIONS REPORT'}</h1></div></div>
    <div className="print-metadata-grid">
      <div><span>Report period</span><strong>{formatDate(startDate)} – {formatDate(endDate)}</strong></div>
      <div><span>Generated</span><strong>{generatedDate}</strong></div>
    </div>
    {view === 'procedures' ? <ProcedureActivitySummary data={data.procedureActivity} print /> : <>
    <section className="print-report-section">
      <h2>Clinic Operations Summary</h2>
      <div className="print-report-metrics">
        <div><span>Patient registrations</span><strong>{data.registrations}</strong></div>
        <div><span>Appointments</span><strong>{data.appointments.length}</strong></div>
        <div><span>Visits / consultations</span><strong>{data.visits.length}</strong></div>
        <div><span>Payments received</span><strong>{paymentTotals.length > 0 ? paymentTotals.join(' · ') : 'None'}</strong></div>
      </div>
    </section>
    <ReportDataTable title="Appointment Status" headers={['Status', 'Appointments']} rows={Object.entries(appointmentsByStatus).sort(([first], [second]) => first.localeCompare(second)).map(([status, count]) => [formatStatus(status), String(count)])} emptyMessage="No appointments in this period." />
    <ReportDataTable title="Payments by Method and Currency" headers={['Method', 'Currency', 'Amount']} rows={paymentMethodRows} emptyMessage="No payments in this period." />
    <ReportDataTable title="Current Outstanding Balance" headers={['Currency', 'Balance']} rows={Object.entries(data.outstandingByCurrency).sort(([first], [second]) => first.localeCompare(second)).map(([currency, amount]) => [currency, formatMoney(amount, currency)])} emptyMessage="No outstanding balances." />
    <p className="print-report-note">Outstanding balances are a current snapshot, not a historical balance for the selected dates.</p>
    <ReportDataTable title="Doctor Activity" headers={['Doctor', 'Appointments', 'Visits']} rows={data.doctorActivity.map((doctor) => [doctor.label, String(doctor.appointments), String(doctor.visits)])} emptyMessage="No doctor activity in this period." />
    </>}
    <footer className="print-document-footer">SoapSmile · Report data is limited to the current clinic and existing Reports access.</footer>
  </article>
}

function PrintableClinicalField({ label, value }: { label: string; value: string | null | undefined }) {
  const content = value?.trim()
  if (!content) return null
  return <section className="print-clinical-field"><h2>{label}</h2><p>{content}</p></section>
}

function VisitSummaryDocument({ clinic, patient, visit, clinicianName, prescriptions, investigations, standaloneState, corrections }: { clinic: Clinic; patient: Patient; visit: Visit; clinicianName: string; prescriptions: Prescription[]; investigations: Investigation[]; standaloneState?: 'saved' | 'finalized' | 'unknown'; corrections?: import('./lib/clinicalCorrections').ClinicalCorrection[] }) {
  const demographicDetails = [
    patient.gender,
    patient.date_of_birth ? `Date of birth: ${formatDate(patient.date_of_birth)}` : null,
    patient.approximate_age_years !== null && patient.approximate_age_years !== undefined ? `Approx. age: ${patient.approximate_age_years} years` : null,
  ].filter(Boolean)

  return <article className="print-document print-visit-summary">
    <PrintableClinicHeader clinic={clinic} />
    <div className="print-document-heading"><div><p>Clinical record</p><h1>CLINICAL VISIT SUMMARY</h1>{!visit.appointment_id && <p>{standaloneState === 'saved' ? 'Saved — unfinished' : standaloneState === 'finalized' ? 'Finalized' : 'Standalone finalization status unverified'}</p>}</div></div>
    <div className="print-metadata-grid">
      <div><span>Patient</span><strong>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</strong><small>Patient number {patient.patient_number}</small>{demographicDetails.length > 0 && <small>{demographicDetails.join(' · ')}</small>}</div>
      <div><span>Visit date</span><strong>{formatDateTime(visit.visit_date)}</strong><small>Clinical author / assigned clinician: {clinicianName}</small></div>
    </div>
    {corrections && corrections.length>0 && <section className="print-clinical-field"><h2>Effective corrected record</h2>{corrections.map((row) => <p key={row.id}>{row.kind} ? {row.action} ? revision {row.revision} ? {formatDateTime(row.recorded_at)} ? {row.actor_display_name || row.recorded_by}</p>)}<p>Original evidence and correction reasons remain in the patient history. Withdrawn prescriptions and requests are excluded below.</p></section>}
    <PrintableClinicalField label="Chief complaint" value={visit.chief_complaint} />
    <PrintableClinicalField label="History of present illness" value={visit.hpi} />
    <PrintableClinicalField label="Examination" value={visit.examination} />
    <PrintableClinicalField label="Diagnosis / assessment" value={visit.assessment} />
    <PrintableClinicalField label="Treatment plan" value={visit.treatment_plan} />
    <PrintableClinicalField label="Clinical notes" value={visit.clinical_notes} />
    {(visit.follow_up_date || visit.follow_up_instructions?.trim()) && <section className="print-clinical-field"><h2>Follow-up</h2>{visit.follow_up_date && <p>{formatDate(visit.follow_up_date)}</p>}{visit.follow_up_instructions?.trim() && <p>{visit.follow_up_instructions.trim()}</p>}</section>}
    {prescriptions.length > 0 && <section className="print-record-section"><h2>Prescriptions</h2>{prescriptions.map((prescription) => {
      const details = [prescription.strength, prescription.dose, prescription.route, prescription.frequency, prescription.duration].filter((detail) => detail?.trim())
      return <article className="print-record-block" key={prescription.id}><h3>{prescription.medicine}</h3>{details.length > 0 && <p>{details.join(' · ')}</p>}{prescription.quantity !== null && prescription.quantity !== undefined && <p>Quantity: {prescription.quantity}</p>}{prescription.instructions?.trim() && <p>{prescription.instructions.trim()}</p>}</article>
    })}</section>}
    {investigations.length > 0 && <section className="print-record-section"><h2>Investigations</h2>{investigations.map((investigation) => <article className="print-record-block" key={investigation.id}><h3>{investigation.investigation_type}</h3>{investigation.status?.trim() && <p>Status: {investigation.status.trim()}</p>}{investigation.result?.trim() && <p>Result: {investigation.result.trim()}</p>}{investigation.result_date && <p>Result date: {formatDate(investigation.result_date)}</p>}{investigation.notes?.trim() && <p>{investigation.notes.trim()}</p>}</article>)}</section>}
    <footer className="print-document-footer">Confidential patient clinical information.</footer>
  </article>
}

function VisitRecordsSummary({ prescriptions, investigations }: { prescriptions: Prescription[]; investigations: Investigation[] }) {
  return <div className="visit-record-summary"><div><span>Prescriptions</span>{prescriptions.length === 0 ? <p>None active</p> : prescriptions.map((prescription) => <p key={prescription.id}><strong>{prescription.medicine}</strong>{prescription.dose ? ` · ${prescription.dose}` : ''}{prescription.frequency ? ` · ${prescription.frequency}` : ''}</p>)}</div><div><span>Investigations</span>{investigations.length === 0 ? <p>None active</p> : investigations.map((investigation) => <p key={investigation.id}><strong>{investigation.investigation_type}</strong>{investigation.status ? ` · ${investigation.status}` : ''}</p>)}</div></div>
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

function OdontogramWorkspace({ clinicId, userId, role }: { clinicId: string; userId: string; role: UserRole }) {
  const [patients, setPatients] = useState<Patient[]>([])
  const [search, setSearch] = useState('')
  const [patient, setPatient] = useState<Patient | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  const [page,setPage] = useState(1)
  const [total,setTotal] = useState(0)
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
      setLoading(true)
      setError(null)
      try {
        const result=await searchPatients(clinicId,search,page,8)
        if (result.error) throw result.error
        if (!cancelled) { setPatients((result.data ?? []) as Patient[]); setTotal(result.count ?? 0) }
      } catch { if (!cancelled) { setPatients([]); setError('We could not retrieve patients. Refresh and try again.') } }
      finally { if (!cancelled) setLoading(false) }
    }
    void load()
    return () => { cancelled = true }
  }, [clinicId, refresh, search, page])

  const matches=patients
  const pageCount=Math.max(1,Math.ceil(total/8))
  const effectivePage=page

  return <div className="patients-page odontogram-page"><div className="page-heading"><div><p className="eyebrow">Clinical dental records</p><h1>Odontogram</h1><p className="panel-copy">Find a patient to review tooth history, record in an eligible visit, or correct your latest entry.</p></div><button type="button" className="button-secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh patients</button></div>
    <div className="odontogram-workspace"><aside className="odontogram-patient-finder"><PatientSearchField label="Search patients" value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="File number, name, or phone" />
      {loading && <SoapSmileLoadingState>Loading patients...</SoapSmileLoadingState>}{error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
      {!loading && !error && <><p className="result-count">{total} matching patients</p><div className="odontogram-patient-results">{matches.map((row) => <button type="button" className={patient?.id === row.id ? 'selected' : ''} aria-pressed={patient?.id === row.id} key={row.id} onClick={() => setPatient(row)}><strong>{[row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ')}</strong><span>File {row.patient_number}</span><small>{row.phone || 'Phone not recorded'}</small></button>)}</div><div className="form-actions"><button type="button" className="button-secondary" disabled={effectivePage === 1} onClick={() => setPage(effectivePage - 1)}>Previous</button><span>{effectivePage} / {pageCount}</span><button type="button" className="button-secondary" disabled={effectivePage === pageCount} onClick={() => setPage(effectivePage + 1)}>Next</button></div>{matches.length === 0 && <SoapSmileEmptyState><p>No matching patients. Try a file number, name, or phone.</p></SoapSmileEmptyState>}</>}
    </aside><section className="odontogram-patient-workspace" aria-label="Selected patient odontogram">{patient ? <PatientOdontogram key={clinicId + ':' + patient.id} clinicId={clinicId} patient={patient} userId={userId} role={role} /> : <SoapSmileEmptyState icon="odontogram"><h2>Select a patient</h2><p>Patient identity, dental chart and correction history will appear here.</p></SoapSmileEmptyState>}</section></div>
  </div>
}

function PatientOdontogram({ clinicId, patient, userId, role }: { clinicId: string; patient: Patient; userId: string; role: UserRole }) {
  const [visits, setVisits] = useState<Visit[]>([])
  const [statuses, setStatuses] = useState<Record<string, AppointmentStatus>>({})
  const [lifecycles, setLifecycles] = useState<Record<string, StandaloneVisitLifecycle>>({})
  const [visitId, setVisitId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
      setLoading(true)
      setError(null)
      try {
        const rows: Visit[] = []
        for (let offset = 0; ;) {
          const result = await supabase.from('visits').select('*').eq('clinic_id', clinicId).eq('patient_id', patient.id).order('visit_date', { ascending: false }).order('id').range(offset, offset + 499)
          if (result.error) throw result.error
          const batch = (result.data ?? []) as Visit[]
          if (!batch.length) break
          rows.push(...batch)
          offset += batch.length
        }
        const appointmentIds = [...new Set(rows.flatMap((row) => row.appointment_id ? [row.appointment_id] : []))]
        const appointmentStatuses: Record<string, AppointmentStatus> = {}
        for (let start = 0; start < appointmentIds.length; start += 100) {
          const result = await supabase.from('appointments').select('id, status').eq('clinic_id', clinicId).in('id', appointmentIds.slice(start, start + 100))
          if (result.error) throw result.error
          for (const row of (result.data ?? []) as Array<Pick<Appointment, 'id' | 'status'>>) appointmentStatuses[row.id] = row.status
        }
        const lifecycleRows: StandaloneVisitLifecycle[] = []
        const standaloneIds = rows.filter((row) => !row.appointment_id).map((row) => row.id)
        for (let start = 0; start < standaloneIds.length; start += 100) {
          const result = await supabase.from('standalone_visit_lifecycle').select('*').eq('clinic_id', clinicId).in('visit_id', standaloneIds.slice(start, start + 100))
          if (result.error) throw result.error
          lifecycleRows.push(...(result.data ?? []) as StandaloneVisitLifecycle[])
        }
        const lifecycleMap = Object.fromEntries(lifecycleRows.map((row) => [row.visit_id, row]))
        const canRecord = (row: Visit) => (role === 'admin' || row.doctor_id === userId) && (row.appointment_id ? appointmentStatuses[row.appointment_id] === 'in_progress' : lifecycleMap[row.id]?.state === 'saved')
        const preferred = rows.find((row) => row.appointment_id && canRecord(row)) ?? rows.find(canRecord) ?? rows[0]
        if (cancelled) return
        setVisits(rows)
        setStatuses(appointmentStatuses)
        setLifecycles(lifecycleMap)
        setVisitId(preferred?.id ?? '')
      } catch { if (!cancelled) { setVisits([]); setError('We could not verify clinical visit context. Refresh and try again.') } }
      finally { if (!cancelled) setLoading(false) }
    }
    void load()
    return () => { cancelled = true }
  }, [clinicId, patient.id, role, userId, refresh])
  const visit = visits.find((row) => row.id === visitId) ?? null
  const canCreate = Boolean(visit && (role === 'admin' || visit.doctor_id === userId) && (visit.appointment_id ? statuses[visit.appointment_id] === 'in_progress' : lifecycles[visit.id]?.state === 'saved'))
  return <><div className="odontogram-patient-identity"><div><p className="eyebrow">Patient dental workspace</p><h2>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</h2><strong>File {patient.patient_number}</strong></div><button type="button" className="button-secondary" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh visit context</button></div>
    {loading && <SoapSmileLoadingState>Verifying clinical visits...</SoapSmileLoadingState>}{error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
    {!loading && !error && <>{visits.length > 0 && <label className="odontogram-visit-picker">Recording / review visit<select value={visitId} onChange={(event) => setVisitId(event.target.value)}>{visits.map((row) => <option key={row.id} value={row.id}>{formatDateTime(row.visit_date)} - {row.appointment_id ? statuses[row.appointment_id]?.replaceAll('_', ' ') || 'Review only' : lifecycles[row.id]?.state === 'saved' ? 'Saved — unfinished' : lifecycles[row.id]?.state === 'finalized' ? 'Finalized' : 'Review only'}</option>)}</select></label>}
      {!canCreate && <p className="dental-context-note">History is available for review. New recording requires an eligible existing clinical visit or an in-progress consultation with appropriate authorization. No new visit or appointment is created here.</p>}
      <DentalChart key={visitId + ':' + refresh} clinicId={clinicId} patientId={patient.id} visit={visit} userId={userId} role={role} canCreate={canCreate} defaultOpen />
    </>}
  </>
}

function DentalChart({ clinicId, visit, patientId, userId, role, canCreate, defaultOpen = false, onActivityCount }: { clinicId: string; visit: Visit | null; patientId?: string; userId: string; role?: UserRole; canCreate: boolean; defaultOpen?: boolean; onActivityCount?: (count: number | null) => void }) {
  const correctionState=useCorrections(clinicId)
  const chartPatientId = visit?.patient_id ?? patientId
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [entries, setEntries] = useState<DentalChartEntry[]>([])
  const [correctableVisits, setCorrectableVisits] = useState<string[]>([])
  const [clinicianNames, setClinicianNames] = useState<Record<string, string>>({})
  const [correctionEntry, setCorrectionEntry] = useState<DentalChartEntry | null>(null)
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

  useUnsavedWorkspace(Boolean(finding || procedureText || notes || surfaces.length), saving)
  const entryLock = useRef(false)
  useEffect(() => {
    const { chains, unverifiedEntries } = inspectDentalEntryChains(entries)
    const unverified = new Set(unverifiedEntries.map((entry) => entry.tooth_number))
    onActivityCount?.(loading || error || correctionState.loading || correctionState.error ? null : chains.map((chain) => chain[chain.length - 1]).filter((entry) => entry.visit_id === visit?.id && !unverified.has(entry.tooth_number) && effectiveRecord(entry,correctionState.rows,'dental')).length)
  }, [entries, onActivityCount, visit?.id, loading, error, correctionState.rows, correctionState.loading, correctionState.error])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false

    async function loadEntries() {
      if (!supabase || !chartPatientId) {
        setError('Supabase is not configured.')
        return
      }
      setLoading(true)
      try {
        const patientVisits: Array<Pick<Visit, 'id' | 'visit_date' | 'doctor_id' | 'appointment_id'>> = []
        // Read every page: a truncated history could mistake a superseded row for current.
        for (let offset = 0; ;) {
          const result = await supabase.from('visits').select('id, visit_date, doctor_id, appointment_id')
            .eq('clinic_id', clinicId).eq('patient_id', chartPatientId).order('id').range(offset, offset + 499)
          if (result.error) throw result.error
          const rows = (result.data ?? []) as typeof patientVisits
          patientVisits.push(...rows)
          if (rows.length === 0) break
          offset += rows.length
        }
        const allEntries: DentalChartEntry[] = []
        const appointmentStatuses: Record<string, AppointmentStatus> = {}
        const names: Record<string, string> = {}
        for (let batch = 0; batch < patientVisits.length; batch += 100) {
          const visits = patientVisits.slice(batch, batch + 100)
          for (let offset = 0; ;) {
            const result = await supabase.from('dental_chart_entries').select('*').eq('clinic_id', clinicId)
              .in('visit_id', visits.map((row) => row.id)).order('created_at').order('id').range(offset, offset + 499)
            if (result.error) throw result.error
            const rows = (result.data ?? []) as DentalChartEntry[]
            allEntries.push(...rows)
            if (rows.length === 0) break
            offset += rows.length
          }
          const appointmentIds = visits.flatMap((row) => row.appointment_id ? [row.appointment_id] : [])
          if (appointmentIds.length) {
            const result = await supabase.from('appointments').select('id, status').eq('clinic_id', clinicId).in('id', appointmentIds)
            if (result.error) throw result.error
            for (const row of (result.data ?? []) as Array<Pick<Appointment, 'id' | 'status'>>) appointmentStatuses[row.id] = row.status
          }
        }
        allEntries.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        const authors = [...new Set(allEntries.map((entry) => entry.recorded_by))]
        for (let batch = 0; batch < authors.length; batch += 100) {
          const result = await supabase.from('profiles').select('id, display_name').in('id', authors.slice(batch, batch + 100))
          for (const profile of (result.data ?? []) as Array<{ id: string; display_name?: string | null }>) {
            names[profile.id] = profile.display_name?.trim() || 'Clinician name unavailable'
          }
        }
        if (cancelled) return
        setError(null)
        setVisitDates(Object.fromEntries(patientVisits.map((row) => [row.id, row.visit_date])))
        setCorrectableVisits(patientVisits.filter((row) => row.doctor_id === userId && (!row.appointment_id || ['in_progress', 'completed'].includes(appointmentStatuses[row.appointment_id]))).map((row) => row.id))
        setClinicianNames(names)
        setEntries(allEntries)
      } catch {
        if (cancelled) return
        setEntries([])
        setCorrectableVisits([])
        setError('We could not load complete dental correction history. Refresh before continuing.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadEntries()
    return () => { cancelled = true }
  }, [clinicId, isOpen, refreshVersion, userId, visit?.id, chartPatientId])

  const { chains, unverifiedEntries } = inspectDentalEntryChains(entries)
  const unverifiedTeeth = new Set(unverifiedEntries.map((entry) => entry.tooth_number))
  const effectiveEntries = correctionState.loading || correctionState.error ? [] : chains.map((chain) => chain[chain.length - 1]).filter((entry) => !unverifiedTeeth.has(entry.tooth_number) && effectiveRecord(entry,correctionState.rows,'dental'))
  const canCorrect = (entry: DentalChartEntry) => !loading && !correctionState.loading && !correctionState.error && role === 'doctor' && entry.recorded_by === userId && correctableVisits.includes(entry.visit_id) && !unverifiedTeeth.has(entry.tooth_number)

  const availableSurfaces = selectedTooth === null
    ? dentalSurfaceOptions.filter((surface) => surface.value !== 'occlusal' && surface.value !== 'incisal')
    : dentalSurfaceOptions.filter((surface) => {
      if (surface.value === 'occlusal') return selectedTooth % 10 >= 4
      if (surface.value === 'incisal') return selectedTooth % 10 <= 3
      return true
    })

  async function saveEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (entryLock.current || !canCreate) return
    const trimmedFinding = finding.trim()
    const trimmedProcedure = procedureText.trim()
    if (selectedTooth === null || (!trimmedFinding && !trimmedProcedure)) {
      setError('Select a tooth and enter a finding or treatment/procedure.')
      return
    }
    if (!supabase || !visit) {
      setError('Supabase is not configured.')
      return
    }

    entryLock.current = true
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
    entryLock.current = false
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
        {defaultOpen && <div className="dental-chart-heading"><div><p className="card-label">Dental chart</p><h3>Odontogram</h3></div><span>{visit ? 'Visit ' + formatDateTime(visit.visit_date) : 'Patient dental history'}</span></div>}
        <div className="dental-workstation"><div className="odontogram-canvas">
        <div className="odontogram-canvas-heading"><span>PERMANENT DENTITION</span><span>FDI notation · patient perspective</span></div>
        <div className="odontogram-quadrants">{adultDentalQuadrants.map((quadrant) => <section className="odontogram-quadrant" key={quadrant.label}><h4>{quadrant.label}</h4><div>{quadrant.teeth.map((toothNumber) => {
          const hasEntries = effectiveEntries.some((entry) => entry.tooth_number === toothNumber)
          const hasFinding = effectiveEntries.some((entry) => entry.tooth_number === toothNumber && entry.finding)
          const hasProcedure = effectiveEntries.some((entry) => entry.tooth_number === toothNumber && entry.procedure_text)
          return <button className={`odontogram-tooth${selectedTooth === toothNumber ? ' selected' : ''}${hasEntries ? ' has-entry' : ''}${hasFinding ? ' has-finding' : ''}${hasProcedure ? ' has-procedure' : ''}`} key={toothNumber} type="button" aria-pressed={selectedTooth === toothNumber} aria-label={`Tooth ${toothNumber}${hasEntries ? ', has recorded entries' : ''}${hasFinding ? ', recorded finding' : ''}${hasProcedure ? ', recorded treatment' : ''}`} onClick={() => { setSelectedTooth(toothNumber); setSurfaces([]) }}><SoapSmileTooth number={toothNumber} /><span>{toothNumber}</span><span className="tooth-indicators" aria-hidden="true">{hasFinding && <i className="finding-dot" />}{hasProcedure && <i className="procedure-dot" />}</span></button>
        })}</div></section>)}</div>
        <div className="odontogram-legend"><span><i className="selection-dot" />Selected tooth</span><span><i className="finding-dot" />Recorded finding</span><span><i className="procedure-dot" />Recorded treatment</span></div>
        <p className="odontogram-disclaimer">Markers use the latest version of each recorded entry. They do not imply current condition or treatment completion.</p>
        </div><div className="dental-context-panel">
        <div className="dental-selected-context"><SoapSmileIcon name="odontogram" /><div><span className="summary-overline">TOOTH CONTEXT</span><strong>{selectedTooth === null ? 'Select a tooth to inspect' : `Tooth ${selectedTooth} · FDI`}</strong><small>{selectedTooth === null ? 'Choose a tooth on the chart.' : `${entries.filter((entry) => entry.tooth_number === selectedTooth).length} recorded entries in patient history`}</small></div></div>
        {canCreate && <form className="dental-entry-form" onSubmit={saveEntry}>
          <h4>{selectedTooth === null ? 'Select a tooth' : `Tooth ${selectedTooth}`}</h4>
          <fieldset disabled={selectedTooth === null || saving}>
            <legend>Surfaces (optional)</legend>
            <div className="dental-surface-options">{availableSurfaces.map((surface) => <label key={surface.value}><input type="checkbox" checked={surfaces.includes(surface.value)} onChange={(event) => setSurfaces((current) => event.target.checked ? [...current, surface.value] : current.filter((value) => value !== surface.value))} />{surface.label}</label>)}</div>
          </fieldset>
          <div className="dental-entry-fields"><label>Finding / condition<input value={finding} onChange={(event) => setFinding(event.target.value)} maxLength={500} placeholder="For example, caries" disabled={selectedTooth === null || saving} /></label><label>Treatment / procedure<input value={procedureText} onChange={(event) => setProcedureText(event.target.value)} maxLength={500} placeholder="For example, restoration" disabled={selectedTooth === null || saving} /></label><label className="dental-notes">Notes (optional)<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} maxLength={2000} disabled={selectedTooth === null || saving} /></label></div>
          <button type="submit" disabled={saving || selectedTooth === null || (!finding.trim() && !procedureText.trim())}>{saving ? <><SoapSmileCompanion state="saving" />Saving...</> : 'Save Entry'}</button>
        </form>}
        {!canCreate && <p className="dental-context-note">Review recorded findings and treatments in the patient dental history below.</p>}
        </div></div>
        {loading && <SoapSmileLoadingState>Loading dental history...</SoapSmileLoadingState>}
        <div className="dental-history-heading"><h4>Current entries / Corrections</h4>{selectedTooth !== null && <button type="button" className="button-secondary inline-button" onClick={() => { setSelectedTooth(null); setSurfaces([]) }}>Show all teeth</button>}<button type="button" className="button-secondary inline-button" disabled={loading} onClick={() => setRefreshVersion((version) => version + 1)}>Refresh history</button></div>
        <p className="dental-context-note">To correct an entry, use Correct entry beside its latest version below. Corrections require the active assigned doctor who originally recorded it; administrator access alone does not permit corrections.</p>
        {!correctionState.loading && !correctionState.error && effectiveEntries.length > 0 && <div className="dental-current-entries" role="region" aria-label="Current dental entries and correction actions" tabIndex={0}>{effectiveEntries.filter((entry) => selectedTooth === null || entry.tooth_number === selectedTooth).map((entry) => <article key={entry.id}><div><strong>Tooth {entry.tooth_number}</strong><p>{entry.finding || entry.procedure_text}</p><small>{clinicianNames[entry.recorded_by] || 'Clinician name unavailable'} - {formatDateTime(entry.created_at)}</small></div>{canCorrect(entry) ? <button type="button" className="button-secondary dental-correct-button" disabled={saving} onClick={() => { setCorrectionEntry(entry); setMessage(null) }}>Correct entry</button> : <small>Review only</small>}<ClinicalCorrectionAction kind="dental" record={entry} rows={correctionState.rows} userId={userId} role={role} authorId={entry.recorded_by} onSaved={correctionsChanged} /></article>)}</div>}
        {unverifiedEntries.length > 0 && <SoapSmileFeedback tone="error">Some dental history has an incomplete or invalid correction chain. Current-state markers and correction actions are withheld for teeth {Array.from(unverifiedTeeth).sort((a, b) => a - b).join(', ')}. The unverified records remain below for review; refresh history and have the data reviewed.</SoapSmileFeedback>}
        {!loading && !error && entries.length === 0 && <SoapSmileEmptyState><p>No dental entries recorded for this patient.</p></SoapSmileEmptyState>}
        {entries.length > 0 && <div className="dental-entry-history" tabIndex={0} role="region" aria-label="Patient dental history"><h4>Patient dental history</h4>{chains.map((chain) => <section className="dental-correction-chain" key={chain[0].id}>{chain.map((entry, index) => {
          const withdrawn=latestCorrection(correctionState.rows,'dental',entry.id)?.action==='withdraw'
          const current = index === chain.length - 1 && !withdrawn
          const correctable = current && canCorrect(entry)
          return <article className={'dental-entry' + (current ? ' dental-entry-current' : ' dental-entry-superseded')} key={entry.id}>
            <div><strong>Tooth {entry.tooth_number} - {index === 0 ? 'Original entry' : 'Correction ' + index}</strong><span className="dental-version-label">{correctionState.loading || correctionState.error ? 'Effective status unverified' : withdrawn ? 'Withdrawn error - retained as history' : current ? unverifiedTeeth.has(entry.tooth_number) ? 'Latest in chain / Tooth state unverified' : 'Latest / Current' : index === 0 ? 'Corrected' : 'Corrected again'}</span></div>
            <time>{visitDates[entry.visit_id] ? 'Visit ' + formatDateTime(visitDates[entry.visit_id]) + ' - ' : ''}Recorded {formatDateTime(entry.created_at)}</time>
            <p className="dental-entry-clinician">Recorded by {clinicianNames[entry.recorded_by] || 'Clinician name unavailable'}</p>
            {entry.surfaces.length > 0 && <span>{entry.surfaces.map((surface) => dentalSurfaceOptions.find((option) => option.value === surface)?.label ?? surface).join(', ')}</span>}
            {entry.finding && <p><b>Finding:</b> {entry.finding}</p>}{entry.procedure_text && <p><b>Treatment / procedure:</b> {entry.procedure_text}</p>}{entry.notes && <p><b>Notes:</b> {entry.notes}</p>}
            {entry.correction_reason && <p className="dental-correction-reason"><b>Correction reason:</b> {entry.correction_reason}</p>}
            {correctable && <button className="button-secondary dental-correct-button" type="button" disabled={saving} onClick={() => { setCorrectionEntry(entry); setMessage(null) }}>Correct entry</button>}
            {!current && !withdrawn && <span className="dental-chain-link" aria-hidden="true">Continued by the correction below</span>}
          </article>
        })}</section>)}</div>}
        {unverifiedEntries.length > 0 && <div className="dental-entry-history" role="region" aria-label="Unverified dental history"><h4>Unverified dental history - excluded from current state</h4>{unverifiedEntries.map((entry, index) => <article className="dental-entry" key={entry.id + '-' + index}><strong>Tooth {entry.tooth_number} - Unverified {entry.supersedes_entry_id ? 'correction' : 'original entry'}</strong><p>Visit {formatDateTime(visitDates[entry.visit_id])} - Recorded {formatDateTime(entry.created_at)} by {clinicianNames[entry.recorded_by] || 'Clinician name unavailable'}</p><p>Surfaces: {entry.surfaces.map((surface) => dentalSurfaceOptions.find((option) => option.value === surface)?.label ?? surface).join(', ') || 'Not specified'}</p>{entry.finding && <p><b>Finding:</b> {entry.finding}</p>}{entry.procedure_text && <p><b>Treatment / procedure:</b> {entry.procedure_text}</p>}{entry.notes && <p><b>Notes:</b> {entry.notes}</p>}{entry.correction_reason && <p><b>Correction reason:</b> {entry.correction_reason}</p>}</article>)}</div>}
        {correctionState.error && <p role="alert">{correctionState.error}</p>}
        {correctionState.rows.filter((row) => row.kind==='dental' && entries.some((entry) => entry.id===row.record_id)).map((row) => <details key={row.id}><summary>Withdrawn tooth entry - original retained</summary><p>{row.actor_display_name || row.recorded_by} - {formatDateTime(row.recorded_at)}</p><p>Reason: {row.reason}</p></details>)}
        {correctionEntry && <DentalCorrectionDialog key={correctionEntry.id} entry={correctionEntry} onClose={() => setCorrectionEntry(null)} onCorrected={() => { setCorrectionEntry(null); setMessage('Correction saved. The original remains in dental history.'); setRefreshVersion((version) => version + 1) }} />}
        {message && <SoapSmileFeedback tone="success">{message}</SoapSmileFeedback>}
        {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
      </>}
    </section>
  )
}

function DentalCorrectionDialog({ entry, onClose, onCorrected }: { entry: DentalChartEntry; onClose: () => void; onCorrected: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [finding, setFinding] = useState(entry.finding ?? '')
  const [procedure, setProcedure] = useState(entry.procedure_text ?? '')
  const [notes, setNotes] = useState(entry.notes ?? '')
  const [surfaces, setSurfaces] = useState<DentalSurface[]>(entry.surfaces)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!reason.trim() || (!finding.trim() && !procedure.trim())) return
    setSaving(true)
    setError(null)
    try {
      const result = await correctDentalChartEntry({ p_entry_id: entry.id, p_surfaces: surfaces, p_finding: finding.trim() || null, p_procedure_text: procedure.trim() || null, p_notes: notes.trim() || null, p_reason: reason.trim() })
      if (result.error) {
        setError('Correction was not saved: ' + result.error.message + (result.error.code ? ' (Code ' + result.error.code + ')' : '') + '. Refresh history before trying again.')
        return
      }
      onCorrected()
    } catch {
      setError('We could not confirm the correction. Check your connection and refresh history before trying again.')
    } finally {
      setSaving(false)
    }
  }

  return <dialog ref={dialog} className="queue-exit-dialog dental-correction-dialog" aria-labelledby="dental-correction-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose() }}>
    <form onSubmit={submit}>
      <p className="eyebrow">Dental history correction</p><h2 id="dental-correction-title">Correct entry - Tooth {entry.tooth_number}</h2>
      <p>This creates a new version on the same tooth and visit. The original stays permanently in history.</p>
      <section className="dental-saved-summary"><h3>Current saved information</h3><p>{entry.finding || 'No finding recorded'}</p><p>{entry.procedure_text || 'No procedure recorded'}</p>{entry.notes && <p>{entry.notes}</p>}<p>Surfaces: {entry.surfaces.length ? entry.surfaces.map((surface) => dentalSurfaceOptions.find((option) => option.value === surface)?.label ?? surface).join(', ') : 'Not specified'}</p></section>
      <fieldset disabled={saving}><legend>Corrected surfaces (optional)</legend><div className="dental-surface-options">{dentalSurfaceOptions.filter((surface) => surface.value !== 'occlusal' || entry.tooth_number % 10 >= 4).filter((surface) => surface.value !== 'incisal' || entry.tooth_number % 10 <= 3).map((surface) => <label key={surface.value}><input type="checkbox" checked={surfaces.includes(surface.value)} onChange={(event) => setSurfaces((current) => event.target.checked ? [...current, surface.value] : current.filter((value) => value !== surface.value))} />{surface.label}</label>)}</div></fieldset>
      <label>Corrected finding / condition<input value={finding} onChange={(event) => setFinding(event.target.value)} maxLength={500} disabled={saving} /></label>
      <label>Corrected treatment / procedure<input value={procedure} onChange={(event) => setProcedure(event.target.value)} maxLength={500} disabled={saving} /></label>
      <label>Corrected notes (optional)<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} maxLength={2000} disabled={saving} /></label>
      <label>Correction reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} required disabled={saving} /></label>
      {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
      <div className="form-actions"><button type="button" className="button-secondary" disabled={saving} onClick={onClose}>Cancel</button><button type="submit" disabled={saving || !reason.trim() || (!finding.trim() && !procedure.trim())}>{saving ? 'Saving correction...' : 'Confirm correction'}</button></div>
    </form>
  </dialog>
}

type AppointmentFormValues = {
  appointment_date: string
  start_time: string
  end_time: string
  duration_minutes: string
  doctor_id: string
  service: string
  notes: string
}

function todayInputValue(timezone: string) {
  return getClinicLocalDate(new Date(), timezone)
}

const initialAppointmentForm: AppointmentFormValues = {
  appointment_date: '',
  start_time: '',
  end_time: '',
  duration_minutes: '30',
  doctor_id: '',
  service: '',
  notes: '',
}

function AppointmentForm({ clinicId, timezone, encounter, patient, onCancel, onCreated }: { clinicId: string; timezone: string; encounter: EncounterContext; patient: Patient; onCancel: () => void; onCreated: (appointment: Appointment) => void }) {
  const [form, setForm] = useState<AppointmentFormValues>(() => ({ ...initialAppointmentForm, appointment_date: todayInputValue(timezone) }))
  const [doctors, setDoctors] = useState<DoctorOption[]>([])
  const [loadingDoctors, setLoadingDoctors] = useState(true)
  const [doctorError, setDoctorError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bookingLock = useRef(false)

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

  useUnsavedWorkspace(Boolean(form.doctor_id || form.start_time || form.service || form.appointment_date !== todayInputValue(timezone) || form.duration_minutes !== '30'), submitting)
  const leave = () => { if (confirmWorkspaceLeave()) onCancel() }
  function updateField(field: keyof AppointmentFormValues, value: string) {
    setForm((current) => {
      const next = { ...current, [field]: value }
      const [hours, minutes] = next.start_time.split(':').map(Number)
      const end = hours * 60 + minutes + Number(next.duration_minutes)
      next.end_time = Number.isFinite(end) && end < 1440 ? String(Math.floor(end / 60)).padStart(2, '0') + ':' + String(end % 60).padStart(2, '0') : ''
      return next
    })
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (bookingLock.current) return
    if (!form.appointment_date || !form.start_time || !form.end_time || !form.doctor_id) {
      setError('Choose a doctor, date, time and duration ending before midnight.')
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

    if (encounter.patient_id !== patient.id || encounter.clinic_id !== clinicId) {
      setError('The selected patient could not be verified. Return to the patient file and try again.')
      return
    }
    bookingLock.current = true
    setSubmitting(true)
    setError(null)
    let bookingResult
    try {
      bookingResult = await bookEncounterAppointment({
        p_encounter_id: encounter.id,
        p_patient_id: patient.id,
        p_doctor_id: form.doctor_id,
        p_appointment_date: form.appointment_date,
        p_start_time: form.start_time,
        p_end_time: form.end_time,
        p_service: form.service.trim() || null,
        p_notes: form.notes.trim() || null,
      })
    } catch {
      setSubmitting(false)
      setError('We could not confirm the booking. Retry this booking to recover an existing appointment safely.')
      return
    } finally {
      bookingLock.current = false
    }
    const { data: createdAppointment, error: insertError } = bookingResult
    setSubmitting(false)
    if (insertError) {
      setError('We could not confirm this appointment. Retry this booking or return to the patient file to review appointments.')
      return
    }
    if (!createdAppointment) {
      setError('The appointment was saved, but it could not be loaded.')
      return
    }
    onCreated(createdAppointment as Appointment)
  }

  return (
    <section className="registration-panel appointment-form-panel" aria-labelledby="book-appointment-heading"><button type="button" className="back-button" disabled={submitting} onClick={leave}>← Back</button>
      <div className="registration-heading"><p className="eyebrow">Appointment booking</p><h2 id="book-appointment-heading">Book Appointment</h2><p className="panel-copy">For {[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} · File {patient.patient_number}</p></div>
      {loadingDoctors && <SoapSmileLoadingState>Loading doctors...</SoapSmileLoadingState>}
      {!loadingDoctors && doctorError && <SoapSmileFeedback tone="error">{doctorError}</SoapSmileFeedback>}
      {!loadingDoctors && !doctorError && <form className="patient-form" onSubmit={handleSubmit}><fieldset disabled={submitting} style={{ display: 'contents' }}>
        <label>Patient<input value={[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')} readOnly /></label>
        <label>Doctor<select value={form.doctor_id} onChange={(event) => updateField('doctor_id', event.target.value)} required><option value="">Select doctor</option>{doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}</select></label>
        <label>Appointment date<input type="date" min={todayInputValue(timezone)} value={form.appointment_date} onChange={(event) => updateField('appointment_date', event.target.value)} required /></label>
        <label>Time<input type="time" value={form.start_time} onChange={(event) => updateField('start_time', event.target.value)} required /></label>
        <label>Duration<select value={form.duration_minutes} onChange={(event) => updateField('duration_minutes', event.target.value)}>{[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select></label>
        <label>Reason (optional)<input value={form.service} onChange={(event) => updateField('service', event.target.value)} /></label>
        </fieldset><div className="form-actions"><button className="button-secondary" onClick={leave} disabled={submitting} type="button">Cancel</button><button type="submit" disabled={submitting}>{submitting ? 'Booking appointment...' : 'Book Appointment'}</button></div>
      </form>}
      {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
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

  useUnsavedWorkspace(Object.entries(form).some(([field, value]) => String(patient[field as keyof Patient] ?? '') !== value), submitting)
  const leave = () => { if (confirmWorkspaceLeave()) onCancel() }

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
    if (!firstName || !lastName) {
      setError('First name and last name are required.')
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
      gender: form.gender.trim() || null,
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
        <label>Gender<select value={form.gender} onChange={(event) => updateField('gender', event.target.value)}><option value="">Not specified</option><option value="Male">Male</option><option value="Female">Female</option></select></label>
        <label>Date of birth<input type="date" value={form.date_of_birth} onChange={(event) => updateField('date_of_birth', event.target.value)} /></label>
        <label>Approximate age (years)<input type="number" min="0" max="130" step="1" value={form.approximate_age_years} onChange={(event) => updateField('approximate_age_years', event.target.value)} placeholder="Use if DOB is unknown" /></label>
        <label>Phone<input type="tel" value={form.phone} onChange={(event) => updateField('phone', event.target.value)} autoComplete="tel" /></label>
        <label>Email<input type="email" value={form.email} onChange={(event) => updateField('email', event.target.value)} autoComplete="email" /></label>
        <label className="full-width">Address<input value={form.address} onChange={(event) => updateField('address', event.target.value)} autoComplete="street-address" /></label>
        <div className="form-actions"><button className="button-secondary" onClick={leave} disabled={submitting} type="button">Cancel</button><button type="submit" disabled={submitting}>{submitting ? <><SoapSmileCompanion state="saving" />Saving changes...</> : 'Save changes'}</button></div>
      </form>
      {error && <SoapSmileFeedback tone="error">{error}</SoapSmileFeedback>}
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
  const isLoading = message.startsWith('Loading')
  return <main className="auth-page auth-page-status"><section className="auth-panel status-panel"><SoapSmileBrand className="login-brand" />{isLoading && <SoapSmileLoader size="large" />}<p className="panel-copy" role={isLoading ? 'status' : undefined}>{message}</p>{action}</section></main>
}

export default App
