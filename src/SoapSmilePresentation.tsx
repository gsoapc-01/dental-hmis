import type { ReactNode } from 'react'

import soapSmileMark from './assets/soap-smile-mark.svg'
import glassTooth from './assets/soap-smile-glass-tooth.png'
import type { Invoice, Patient } from './types/domain'

export type SoapSmileIconName =
  | 'activity'
  | 'appointments'
  | 'arrow-right'
  | 'calendar'
  | 'clear'
  | 'clock'
  | 'doctor'
  | 'billing'
  | 'clinical'
  | 'dashboard'
  | 'investigations'
  | 'logout'
  | 'odontogram'
  | 'patients'
  | 'prescriptions'
  | 'reports'
  | 'settings'
  | 'shield'
  | 'staff'
  | 'close'
  | 'check'
  | 'edit'
  | 'filter'
  | 'history'
  | 'patient-file'
  | 'print'
  | 'search'
  | 'visit'

export function SoapSmileBrand({ className = '' }: { className?: string }) {
  return <div className={`soap-brand ${className}`.trim()}>
    <span className="soap-brand-mark"><img src={soapSmileMark} alt="" /></span>
    <span className="soap-brand-wordmark">Soap<span>Smile</span></span>
  </div>
}

export function SoapSmileIcon({ name, className = '' }: { name: SoapSmileIconName; className?: string }) {
  const icons: Record<SoapSmileIconName, ReactNode> = {
    activity: <><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    appointments: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18M8 15h.01M12 15h.01M16 15h.01" /></>,
    'arrow-right': <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    billing: <><path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Z" /><path d="M8 8h8M8 12h8M8 16h4" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
    clear: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    clinical: <><path d="M6 3v5a6 6 0 0 0 12 0V3M6 3H4v3M18 3h2v3M12 14v2a4 4 0 0 0 8 0v-1" /><circle cx="20" cy="13" r="2" /></>,
    dashboard: <><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>,
    doctor: <><path d="M6 3v5a6 6 0 0 0 12 0V3" /><path d="M6 3H4v3M18 3h2v3M12 14v2a4 4 0 0 0 8 0v-1" /><circle cx="20" cy="13" r="2" /></>,
    edit: <><path d="m15 5 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16l-1 4Z" /></>,
    filter: <><path d="M4 5h16M7 12h10m-7 7h4" /></>,
    history: <><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    investigations: <><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18" /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></>,
    odontogram: <><path d="M12 5.6c-1.4 0-2.3-1.1-4.4-1.1-2.8 0-4.6 2.3-4.6 5.5 0 4.8 3.2 11 5.1 11 1.1 0 1.4-2.3 2.1-4.1.4-1.1.8-1.7 1.8-1.7s1.4.6 1.8 1.7c.7 1.8 1 4.1 2.1 4.1 1.9 0 5.1-6.2 5.1-11 0-3.2-1.8-5.5-4.6-5.5-2.1 0-3 1.1-4.4 1.1Z" /></>,
    'patient-file': <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h7M9 17h7" /></>,
    patients: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    print: <><path d="M6 9V3h12v6M6 17H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" /><path d="M6 14h12v7H6zM18 12h.01" /></>,
    prescriptions: <><path d="m10.5 20.5 10-10a5.66 5.66 0 0 0-8-8l-10 10a5.66 5.66 0 0 0 8 8Z" /><path d="m8.5 8.5 7 7" /></>,
    reports: <><path d="M3 3v18h18M8 17v-3M13 17V5M18 17V9" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
    settings: <><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M2 14h4M10 8h4M18 16h4" /></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
    staff: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M12 11v6M9 14h6" /></>,
    visit: <><path d="M5 3h14v18H5zM9 8h6M9 12h6M9 16h3" /><path d="m15 16 2 2 4-4" /></>,
  }

  return <svg className={`soap-icon ${className}`.trim()} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>
}

export function SoapSmileLoader({ size = 'inline', label }: { size?: 'button' | 'inline' | 'large'; label?: string }) {
  return <span className={`soap-loader soap-loader-${size}`} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <span className="soap-loader-orbit" />
    {size === 'large' ? <SoapSmileCompanion state="loading" /> : <img src={soapSmileMark} alt="" />}
  </span>
}

export function SoapSmileLoadingState({ children }: { children: ReactNode }) {
  const message = typeof children === 'string' ? children.toLowerCase() : ''
  const state = message.includes('history') || message.includes('clinical') ? 'clinical' : message.includes('search') ? 'searching' : 'loading'
  return <div className="soap-loading-state" role="status"><SoapSmileCompanion state={state} /><span>{children}</span><span className="soap-loading-track" aria-hidden="true" /></div>
}

export function SoapSmileFeedback({ children, tone = 'info' }: { children: ReactNode; tone?: 'success' | 'error' | 'warning' | 'info' }) {
  return <div className={`soap-feedback soap-feedback-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{tone === 'success' || tone === 'error' ? <SoapSmileCompanion state={tone} /> : <img src={soapSmileMark} alt="" />}<span>{children}</span><svg viewBox="0 0 40 16" aria-hidden="true"><path d={tone === 'error' ? 'M3 13 Q20 -5 37 13' : 'M3 3 Q20 21 37 3'} fill="none" stroke="currentColor" strokeWidth="2" /></svg></div>
}

type SoapSmileCompanionState = 'idle' | 'loading' | 'clinical' | 'searching' | 'saving' | 'payment' | 'success' | 'error' | 'waiting'

export function SoapSmileCompanion({ state = 'idle' }: { state?: SoapSmileCompanionState }) {
  const working = state === 'loading' || state === 'saving' || state === 'payment'
  return <span className={`soap-companion companion-${state}`} aria-hidden="true">
    <svg viewBox="0 0 80 86" fill="none"><ellipse className="companion-shadow" cx="40" cy="77" rx="19" ry="3" />
      <g className="companion-character"><path className="companion-arm" d="M19 44q-7 3-6 10M61 44q7 3 6 10" strokeWidth="2.5" strokeLinecap="round" />
        <path className="companion-body" d="M22 16Q30 10 40 15Q50 10 58 16Q65 23 61 38L55 65Q52 76 48 67L44 55Q40 49 36 55L32 67Q28 76 25 65L19 38Q15 23 22 16Z" strokeWidth="1.5" />
        <path className="companion-highlight" d="M25 21Q31 17 36 20" strokeWidth="3" strokeLinecap="round" />
        <path className="companion-accent" d="M25 26Q40 20 55 26" strokeWidth="1.5" strokeLinecap="round" />
        <g className="companion-eyes"><ellipse cx="32" cy="35" rx="2" ry="2.7" /><ellipse cx="48" cy="35" rx="2" ry="2.7" /></g>
        <path className="companion-mouth" d={state === 'error' ? 'M35 44Q40 39 45 44' : 'M35 42Q40 47 45 42'} strokeWidth="1.5" strokeLinecap="round" />
        {(state === 'clinical' || state === 'saving') && <g className="companion-record"><rect x="53" y="44" width="15" height="20" rx="2" /><path d="M57 50h7m-7 4h7m-7 4h4" strokeWidth="1.2" /></g>}
        {state === 'payment' && <g className="companion-security"><path d="m60 44 9 3v6q0 6-9 10-9-4-9-10v-6Z" /><path d="m56 53 3 3 5-6" strokeWidth="1.4" /></g>}
      </g>
      {working && <g className="companion-dots"><circle cx="29" cy="7" r="2" /><circle cx="40" cy="5" r="2" /><circle cx="51" cy="7" r="2" /></g>}
      {state === 'searching' && <path className="companion-scan" d="M12 38h56" strokeWidth="1" />}
    </svg>
  </span>
}

export function SoapSmileCompanionDock() {
  return <footer className="soap-companion-dock"><div><span className="soap-dock-line" /><span>SoapSmile</span><small>Dental care, intelligently connected.</small></div><SoapSmileCompanion /></footer>
}

export function SoapSmileBillingPatientList({ patients, selectedId, onSelect }: { patients: Patient[]; selectedId?: string; onSelect: (patient: Patient) => void }) {
  return <div className="soap-billing-patient-list" role="region" aria-label="Billing patients" tabIndex={0}>{patients.map((patient) => <button className={`soap-billing-patient${patient.id === selectedId ? ' selected' : ''}`} key={patient.id} type="button" aria-pressed={patient.id === selectedId} onClick={() => onSelect(patient)}>
    <span className="soap-patient-monogram" aria-hidden="true">{patient.first_name[0]}{patient.last_name[0]}</span><span><strong>{[patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')}</strong><small>{patient.patient_number}</small>{patient.phone && <small>{patient.phone}</small>}</span><SoapSmileIcon name="arrow-right" />
  </button>)}</div>
}

export function SoapSmileInvoiceSummary({ invoice, formatAmount }: { invoice: Invoice; formatAmount: (amount: number, currency: string) => string }) {
  const values = [
    { label: 'Billed', amount: invoice.total, icon: 'billing' as const },
    { label: 'Paid', amount: invoice.amount_paid, icon: 'check' as const },
    { label: 'Outstanding', amount: invoice.balance, icon: 'clock' as const },
  ]
  return <section className="soap-financial-summary" aria-label={`Recorded values for invoice ${invoice.invoice_number}`}><div className="soap-financial-summary-heading"><span>Latest invoice · {invoice.invoice_number}</span><small>Recorded invoice values · {invoice.currency}</small></div><div className="soap-financial-tiles">{values.map((value) => <div className={`soap-financial-tile tile-${value.label.toLowerCase()}`} key={value.label}><SoapSmileIcon name={value.icon} /><span>{value.label}</span><strong>{formatAmount(value.amount, invoice.currency)}</strong></div>)}</div></section>
}

export function SoapSmileEmptyState({ children, icon = 'odontogram' }: { children: ReactNode; icon?: SoapSmileIconName }) {
  return <div className="soap-empty-state"><span className="soap-empty-visual" aria-hidden="true"><img src={soapSmileMark} alt="" /><SoapSmileIcon name={icon} /></span><div>{children}</div></div>
}

export function SoapSmileDentalEnvironment({ compact = false }: { compact?: boolean }) {
  return <div className={`soap-dental-environment${compact ? ' compact' : ''}`} aria-hidden="true">
    <span className="dental-environment-grid" /><span className="dental-environment-orbit orbit-primary" /><span className="dental-environment-orbit orbit-secondary" />
    <img className="dental-environment-tooth" src={glassTooth} alt="" />
    <span className="dental-environment-scan" /><span className="dental-environment-node node-one" /><span className="dental-environment-node node-two" />
    <span className="dental-environment-marker marker-one">SOAPSMILE / DENTAL CORE</span><span className="dental-environment-marker marker-two">PRECISION · CONNECTION · CARE</span>
  </div>
}

export function SoapSmileLoginEnvironment() {
  return <div className="soap-login-environment" aria-hidden="true" onPointerMove={(event) => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').matches) return
    const bounds = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--soap-depth-x', `${((event.clientX - bounds.left) / bounds.width - 0.5) * 6}px`)
    event.currentTarget.style.setProperty('--soap-depth-y', `${((event.clientY - bounds.top) / bounds.height - 0.5) * 6}px`)
  }} onPointerLeave={(event) => {
    event.currentTarget.style.setProperty('--soap-depth-x', '0px')
    event.currentTarget.style.setProperty('--soap-depth-y', '0px')
  }}><SoapSmileDentalEnvironment /></div>
}

export function SoapSmileOperationsCore({ metrics, personal = false }: { metrics: Array<{ label: string; value: number; icon: SoapSmileIconName }>; personal?: boolean }) {
  return <div className="soap-operations-core"><SoapSmileDentalEnvironment compact />
    <div className="soap-core-metrics">{metrics.map((metric) => <div className="soap-core-metric" key={metric.label}><SoapSmileIcon name={metric.icon} /><strong>{metric.value}</strong><span>{personal ? `My ${metric.label.toLowerCase()}` : metric.label}</span></div>)}</div>
  </div>
}

export function SoapSmileTooth({ number }: { number: number }) {
  const molar = number % 10 >= 6
  const premolar = number % 10 >= 4
  return <svg className="soap-tooth-object" viewBox="0 0 44 60" aria-hidden="true" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
    <path className="tooth-body" d={molar ? 'M8 8 Q14 3 22 7 Q30 3 36 8 Q41 16 36 28 L33 48 Q31 57 28 49 L24 34 Q22 30 20 34 L16 49 Q13 57 11 48 L8 28 Q3 16 8 8Z' : premolar ? 'M10 8 Q16 4 22 7 Q28 4 34 8 Q39 16 33 29 L27 49 Q22 61 17 49 L11 29 Q5 16 10 8Z' : 'M13 7 Q22 4 31 7 L33 22 Q32 28 28 33 L25 51 Q22 57 19 51 L16 33 Q12 28 11 22Z'} />
    <path className="tooth-detail" d={molar ? 'M12 14 Q22 24 32 14 M22 12 V25 M14 29 L16 40 M30 29 L28 40' : 'M15 14 Q22 18 29 14 M22 25 V42'} fill="none" />
  </svg>
}
