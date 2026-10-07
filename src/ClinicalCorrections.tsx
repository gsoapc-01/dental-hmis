import { useEffect, useRef, useState } from 'react'
import type { UserRole } from './types/domain'
import { correctionClient, latestCorrection } from './lib/clinicalCorrections'
import type { ClinicalCorrection, CorrectionKind } from './lib/clinicalCorrections'

const correctionFields = {
  visit: ['chief_complaint', 'hpi', 'examination', 'assessment', 'treatment_plan', 'clinical_notes', 'follow_up_date', 'follow_up_instructions'],
  prescription: ['medicine', 'strength', 'dose', 'route', 'frequency', 'duration', 'quantity', 'instructions'],
  investigation: ['investigation_type', 'notes'],
  procedure: [], dental: [],
} as const

export function CorrectionHistory({ original, rows }: { original: object; rows: ClinicalCorrection[] }) {
  if (!rows.length) return null
  return <details className="clinical-correction-history"><summary>Original record and correction history</summary><h4>Original record</h4><dl>{Object.entries(original).filter(([key]) => Object.values(correctionFields).some((fields) => (fields as readonly string[]).includes(key))).map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{String(value ?? 'Not recorded')}</dd></div>)}</dl>{rows.slice().sort((a,b) => a.revision-b.revision).map((row) => <article key={row.id}><strong>{row.action} · revision {row.revision}{row.admin_recovery ? ' · administrator recovery' : ''}</strong><p>{new Date(row.recorded_at).toLocaleString()} · {row.actor_display_name || row.recorded_by}</p><p>Reason: {row.reason}</p>{row.snapshot && <dl>{Object.entries(row.snapshot).map(([key,value]) => <div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{String(value ?? 'Cleared / not recorded')}</dd></div>)}</dl>}</article>)}</details>
}

export function ClinicalCorrectionAction({ kind, record, rows, userId, role, authorId, onSaved }: {
  kind: CorrectionKind; record: { id: string } & object; rows: ClinicalCorrection[]; userId?: string; role?: UserRole; authorId: string; onSaved: () => void
}) {
  const [action, setAction] = useState<'amend' | 'replace' | 'withdraw' | null>(null)
  const [values, setValues] = useState<Record<string,string>>({})
  const [reason, setReason] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviewRequired,setReviewRequired] = useState(false)
  const lock = useRef(false)
  const latest = latestCorrection(rows,kind,record.id)
  useEffect(() => {
    if (!action) return
    const navigation = (event: Event) => {
      const custom = event as CustomEvent<{ confirmed: boolean }>
      if (event.defaultPrevented) return
      if (busy || (!custom.detail.confirmed && !window.confirm('Discard this unsaved clinical correction?'))) event.preventDefault()
      else custom.detail.confirmed = true
    }
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('soapsmile-before-navigation',navigation); window.addEventListener('beforeunload',unload)
    return () => { window.removeEventListener('soapsmile-before-navigation',navigation); window.removeEventListener('beforeunload',unload) }
  },[action,busy])
  if (!userId || (role !== 'admin' && !(role === 'doctor' && userId === authorId)) || latest?.action === 'withdraw') return null
  function begin(next: 'amend' | 'replace' | 'withdraw') {
    const source = { ...record, ...latest?.snapshot } as Record<string,unknown>
    setValues(Object.fromEntries(correctionFields[kind].map((field) => [field,String(source[field] ?? '')])))
    setAction(next); setReason(''); setError(null); setReviewRequired(false); setRecovery(role === 'admin' && userId !== authorId)
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current || !correctionClient || !action || reviewRequired) return
    if (!window.confirm(`Confirm ${action} of this saved clinical record? The original will remain in history.`)) return
    lock.current = true; setBusy(true); setError(null)
    try {
      const payload = action === 'withdraw' ? null : Object.fromEntries(correctionFields[kind].map((field) => [field,field === 'quantity' && values[field] ? Number(values[field]) : values[field].trim() || null]))
      const result = await correctionClient.rpc('correct_clinical_record',{ p_kind:kind,p_record_id:record.id,p_action:action,p_expected_revision:latest?.revision ?? 0,p_snapshot:payload,p_reason:reason.trim(),p_admin_recovery:recovery })
      if (result.error) throw new Error(result.error.message)
      setAction(null); onSaved()
    } catch (failure) { setReviewRequired(true); setError((failure instanceof Error ? failure.message : 'Correction could not be confirmed.') + ' Cancel this draft and review the latest history before trying again.'); onSaved() }
    finally { lock.current=false; setBusy(false) }
  }
  return <details className="clinical-correction-actions"><summary>More Actions</summary>{!action ? <div className="form-actions">{kind === 'visit' ? <button type="button" className="button-secondary" onClick={() => begin('amend')}>Amend narrative</button> : <><button type="button" className="button-secondary" onClick={() => begin('withdraw')}>Withdraw {kind === 'dental' ? 'erroneous entry' : kind}</button>{(kind === 'prescription' || kind === 'investigation') && <button type="button" className="button-secondary" onClick={() => begin('replace')}>Replace {kind}</button>}</>}</div> : <form className="patient-form" onSubmit={(event) => void save(event)}><fieldset disabled={busy} style={{display:'contents'}}><h4 className="full-width">{action} saved record</h4>{action !== 'withdraw' && correctionFields[kind].map((field) => <label key={field}>{field.replaceAll('_',' ')}<input type={field === 'follow_up_date' ? 'date' : field === 'quantity' ? 'number' : 'text'} min={field === 'quantity' ? '0.01' : undefined} step={field === 'quantity' ? 'any' : undefined} maxLength={4000} value={values[field]} onChange={(event) => setValues({...values,[field]:event.target.value})} /></label>)}<label className="full-width">Correction reason<textarea required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>{role === 'admin' && <label className="full-width"><input type="checkbox" checked={recovery} onChange={(event) => setRecovery(event.target.checked)} /> Audited administrator recovery (original author unavailable)</label>}<div className="form-actions"><button type="submit" disabled={reviewRequired}>{busy ? 'Recording...' : 'Record correction'}</button><button type="button" className="button-secondary" onClick={() => { if (window.confirm('Discard this unsaved correction?')) setAction(null) }}>Cancel</button></div>{error && <p role="alert">{error}</p>}</fieldset></form>}</details>
}
