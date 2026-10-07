import { ClinicalCorrectionAction, CorrectionHistory } from './ClinicalCorrections'
import { useCorrections, correctionsChanged } from './lib/useCorrections'
import { effectiveRecord, pagedResult } from './lib/clinicalCorrections'
import { useEffect, useRef, useState } from 'react'
import type { UserRole, Visit } from './types/domain'
import { effectiveProcedures, procedureClient } from './lib/procedures'
import type { PerformedProcedure, ProcedureActivity, ProcedureCatalog } from './lib/procedures'

const emptyEntry = { catalog: '', quantity: '1', tooth: '', note: '', reason: '' }
function useProcedureDraft(dirty: boolean, busy: boolean) {
  useEffect(() => {
    const navigation = (event: Event) => {
      const custom = event as CustomEvent<{ confirmed: boolean }>
      if (event.defaultPrevented) return
      if (busy) { window.alert('Please wait for the procedure save to finish.'); event.preventDefault(); return }
      if (dirty && !custom.detail.confirmed) {
        if (window.confirm('Discard unsaved procedure changes? Saved records remain unchanged.')) custom.detail.confirmed = true
        else event.preventDefault()
      }
    }
    const unload = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('soapsmile-before-navigation', navigation)
    window.addEventListener('beforeunload', unload)
    return () => { window.removeEventListener('soapsmile-before-navigation', navigation); window.removeEventListener('beforeunload', unload) }
  }, [dirty, busy])
}

export function VisitProcedures({ visit, userId, role, canCreate, disabled = false, onCount, onContinue }: {
  visit: Visit; userId?: string; role?: UserRole; canCreate: boolean; disabled?: boolean
  onCount?: (count: number | null) => void; onContinue?: () => void
}) {
  const correctionState=useCorrections(visit.clinic_id,visit.id)
  const [catalog, setCatalog] = useState<ProcedureCatalog[]>([])
  const [rows, setRows] = useState<PerformedProcedure[]>([])
  const [form, setForm] = useState(emptyEntry)
  const [search, setSearch] = useState('')
  const [correction, setCorrection] = useState<PerformedProcedure | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [reviewNeeded, setReviewNeeded] = useState(false)
  const [saved, setSaved] = useState(false)
  const procedureSelect = useRef<HTMLSelectElement>(null)
  const lock = useRef(false)
  useProcedureDraft(JSON.stringify(form) !== JSON.stringify(emptyEntry), busy)
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        if (!procedureClient) throw new Error('Supabase is not configured.')
        const [catalogResult, recordsResult] = await Promise.all([
          pagedResult(() => procedureClient!.from('procedure_catalog').select('*').eq('clinic_id', visit.clinic_id).order('name').order('id')),
          pagedResult(() => procedureClient!.from('performed_procedures').select('*').eq('clinic_id', visit.clinic_id).eq('visit_id', visit.id).order('recorded_at').order('id')),
        ])
        if (catalogResult.error || recordsResult.error) throw new Error('Procedures could not be verified. Refresh before continuing.')
        if (cancelled) return
        setCatalog(catalogResult.data ?? []); setRows(recordsResult.data ?? []); setReviewNeeded(false)
      } catch (failure) { if (!cancelled) setError(failure instanceof Error ? failure.message : 'Procedures unavailable.') }
      finally { if (!cancelled) setLoading(false) }
    }
    void load()
    return () => { cancelled = true }
  }, [visit.clinic_id, visit.id, reload])
  const effective = effectiveProcedures(rows).filter((row) => effectiveRecord(row,correctionState.rows,'procedure'))
  useEffect(() => { onCount?.(loading || error || correctionState.loading || correctionState.error ? null : effective.length) }, [loading, error, correctionState.loading, correctionState.error, effective.length, onCount])
  const selected = catalog.find((item) => item.id === form.catalog)
  const options = catalog.filter((item) => (item.active || item.id === correction?.procedure_catalog_id) &&
    (item.id === form.catalog || `${item.name} ${item.code} ${item.category}`.toLowerCase().includes(search.toLowerCase())))
  const canCorrect = (row: PerformedProcedure) => row.recorded_by === userId && (role === 'admin' || (role === 'doctor' && visit.doctor_id === userId))
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current || !procedureClient || reviewNeeded) return
    lock.current = true; setBusy(true); setError(null)
    try {
      const result = await procedureClient.rpc('record_performed_procedure', {
        p_visit_id: visit.id, p_catalog_id: form.catalog, p_quantity: Number(form.quantity),
        p_tooth_number: form.tooth ? Number(form.tooth) : null, p_note: form.note.trim() || null,
        p_supersedes_id: correction?.id ?? null, p_reason: correction ? form.reason.trim() : null,
      })
      if (result.error) throw new Error(result.error.message)
      setForm(emptyEntry); setCorrection(null); setSearch(''); setSaved(true); correctionsChanged(); setReload((value) => value + 1)
    } catch (failure) {
      setReviewNeeded(true)
      setError(`${failure instanceof Error ? failure.message : 'Save could not be confirmed.'} Refresh and review recorded procedures before retrying.`)
    } finally { lock.current = false; setBusy(false) }
  }
  function startCorrection(row: PerformedProcedure) {
    if (JSON.stringify(form) !== JSON.stringify(emptyEntry) && !window.confirm('Discard unsaved procedure entry?')) return
    setCorrection(row); setSearch(''); setForm({ catalog: row.procedure_catalog_id, quantity: String(row.quantity), tooth: row.tooth_number ? String(row.tooth_number) : '', note: row.note ?? '', reason: '' })
  }
  return <section className="profile-card procedure-panel compact-procedure-panel"><div className="section-heading"><div><h3>Procedures Performed</h3><p>Record treatment actually performed, or Consultation Only. Charges are recorded separately.</p></div><button type="button" className="button-secondary" disabled={busy || disabled} onClick={() => setReload((value) => value + 1)}>Refresh</button></div>
    {correctionState.error && <p role="alert">{correctionState.error}</p>}{loading && <p role="status">Verifying procedures…</p>}{error && <p role="alert" className="form-error">{error}</p>}
    {!loading && (canCreate || correction) && <form className="patient-form" onSubmit={(event) => void save(event)}><fieldset disabled={busy || disabled || reviewNeeded} style={{ display: 'contents' }}>
      <label>Search procedures<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label>Procedure performed<select ref={procedureSelect} required value={form.catalog} onChange={(event) => { const item = catalog.find((row) => row.id === event.target.value); setForm({ ...form, catalog: event.target.value, ...(item?.code === 'CONSULTATION_ONLY' ? { quantity: '1', tooth: '' } : {}) }) }}><option value="">Select procedure</option>{options.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.category}{!item.active ? ' (inactive original)' : ''}</option>)}</select></label>
      <label>Quantity<input type="number" min="1" max="1000" step="1" required disabled={selected?.code === 'CONSULTATION_ONLY'} value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></label>
      <label>Tooth (optional, FDI)<input type="number" disabled={selected?.code === 'CONSULTATION_ONLY'} value={form.tooth} onChange={(event) => setForm({ ...form, tooth: event.target.value })} /></label>
      <label className="full-width">Note (optional)<input maxLength={1000} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
      {correction && <label className="full-width">Correction reason<input required maxLength={500} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></label>}
      <div className="form-actions"><button type="submit" disabled={!form.catalog}>{busy ? 'Saving…' : correction ? 'Save Replacement' : 'Record procedure'}</button>{correction && <button type="button" className="button-secondary" onClick={() => { if (window.confirm('Discard this unsaved correction?')) { setCorrection(null); setForm(emptyEntry) } }}>Cancel correction</button>}</div>
    </fieldset></form>}
    {!loading && !error && catalog.every((item) => !item.active) && canCreate && <p>An administrator must add or install a procedure catalog in Settings before recording.</p>}
    {!loading && !error && effective.length === 0 && <p>No structured procedure recorded. Record at least one procedure or Consultation Only before closing.</p>}
    {saved && canCreate && <div className="form-actions"><span role="status">Procedure saved.</span><button type="button" className="button-secondary" disabled={busy || disabled || loading} onClick={() => procedureSelect.current?.focus()}>+ Add another procedure</button>{onContinue && <button type="button" className="button-secondary" disabled={busy || disabled || loading} onClick={onContinue}>Continue to Review</button>}</div>}
    <div className="compact-record-list">{!correctionState.loading && !correctionState.error && effective.map((row) => <article key={row.id}><strong>{row.procedure_name}</strong><span>{row.quantity} unit(s){row.tooth_number ? ' - Tooth ' + row.tooth_number : ''}</span><details><summary>Details / correction actions</summary><p>{new Date(row.performed_at).toLocaleString()}</p>{row.note && <p>{row.note}</p>}{row.supersedes_id && <p>Replacement - {row.correction_reason}</p>}{canCorrect(row) && <button className="button-secondary" type="button" disabled={busy || disabled || loading} onClick={() => startCorrection(row)}>Correct</button>}<ClinicalCorrectionAction kind="procedure" record={row} rows={correctionState.rows} userId={userId} role={role} authorId={visit.doctor_id} onSaved={correctionsChanged} /></details></article>)}</div>
    {(rows.some((row) => row.supersedes_id) || correctionState.rows.some((row) => row.kind==='procedure')) && <details><summary>Correction history</summary>{rows.filter((row) => !effective.some((current) => current.id === row.id)).map((row) => <article className="clinical-record" key={row.id}><strong>{row.procedure_name} - {effectiveRecord(row,correctionState.rows,'procedure') ? 'Superseded' : 'Withdrawn'}</strong><p>{row.quantity} unit(s){row.tooth_number ? ` · Tooth ${row.tooth_number}` : ''}</p>{row.note && <p>{row.note}</p>}<CorrectionHistory original={row} rows={correctionState.rows.filter((event) => event.kind==='procedure' && event.record_id===row.id)} /><p>Recorded {new Date(row.recorded_at).toLocaleString()} · Actor {row.recorded_by}</p></article>)}</details>}
  </section>
}

export function ProcedureCatalogSettings({ clinicId }: { clinicId: string }) {
  const [rows, setRows] = useState<ProcedureCatalog[]>([])
  const [form, setForm] = useState({ code: '', name: '', category: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const lock = useRef(false)
  useProcedureDraft(Boolean(form.code || form.name || form.category), busy)
  useEffect(() => {
    let cancelled = false
    if (procedureClient) void procedureClient.from('procedure_catalog').select('*').eq('clinic_id', clinicId).order('name').then((result) => {
      if (cancelled) return
      if (result.error) setError('Catalog unavailable. Apply the procedure migration, then refresh.')
      else { setRows(result.data ?? []); setError(null) }
    })
    return () => { cancelled = true }
  }, [clinicId, reload])
  async function mutate(item?: ProcedureCatalog, template = false) {
    if (!procedureClient || lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try {
      const result = template ? await procedureClient.rpc('install_dental_procedure_template', { p_clinic_id: clinicId }) : await procedureClient.rpc('manage_procedure_catalog', {
        p_clinic_id: clinicId, p_code: item?.code ?? form.code.trim().toUpperCase(), p_name: item?.name ?? form.name.trim(), p_category: item?.category ?? form.category.trim(), p_active: item ? !item.active : true,
      })
      if (result.error) throw new Error(result.error.message)
      if (!item && !template) setForm({ code: '', name: '', category: '' })
      setReload((value) => value + 1)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Catalog save could not be confirmed. Refresh before retrying.') }
    finally { lock.current = false; setBusy(false) }
  }
  return <section className="registration-panel"><h2>Procedure Catalog</h2><p>Clinic-owned clinical classifications, without prices. Existing codes and names stay stable; deactivate an obsolete entry and create a new code.</p>
    <button type="button" className="button-secondary" disabled={busy} onClick={() => { if (window.confirm('Install the dental starter catalog in this clinic? Existing entries will be preserved.')) void mutate(undefined, true) }}>Install dental starter catalog</button>
    <button type="button" className="button-secondary" disabled={busy} onClick={() => setReload((value) => value + 1)}>Refresh catalog</button>
    <form className="patient-form" onSubmit={(event) => { event.preventDefault(); void mutate() }}><fieldset disabled={busy} style={{ display: 'contents' }}><label>Code<input required pattern="[A-Za-z][A-Za-z0-9_]{0,59}" maxLength={60} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} /></label><label>Name<input required maxLength={150} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>Category<input required maxLength={100} value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></label><div className="form-actions"><button type="submit">Add catalog procedure</button></div></fieldset></form>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="table-frame"><table className="patient-table"><thead><tr><th>Procedure</th><th>Category</th><th>Status</th><th>Action</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.name}<small> · {row.code}</small></td><td>{row.category}</td><td>{row.active ? 'Active' : 'Inactive'}</td><td><button type="button" className="button-secondary" disabled={busy} onClick={() => void mutate(row)}>{row.active ? 'Deactivate' : 'Activate'}</button></td></tr>)}</tbody></table></div>
  </section>
}

export function ProcedureActivitySummary({ data, print = false }: { data: ProcedureActivity; print?: boolean }) {
  const metrics = [['Procedure units', data.units], ['Procedure records', data.records], ['Unique patients', data.patients], ['Male patients', data.male], ['Female patients', data.female], ['Other / not recorded', data.other]] as const
  return <section className={print ? 'print-report-section print-procedure-activity' : 'procedure-activity'}><h2>{print ? 'Summary' : 'Procedure Activity'}</h2><p className={print ? 'print-report-note' : 'report-caption'}>Patients are unique within each procedure and overall. Gender uses the current patient profile. Only effective structured procedure records are included.</p>
    <div className={print ? 'print-report-metrics' : 'procedure-metrics'}>{metrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    {print && <h2 className="print-procedure-table-heading">Procedure Activity</h2>}
    <div className="procedure-table-wrap" tabIndex={print ? undefined : 0} role={print ? undefined : 'region'} aria-label={print ? undefined : 'Procedure activity table'}><table className={print ? 'print-report-table procedure-table' : 'patient-table procedure-table'}><thead><tr><th>Procedure</th><th>Category</th><th>Units</th><th>Patients</th><th>Male</th><th>Female</th><th>Other</th></tr></thead><tbody>{data.rows.map((row) => <tr key={row.procedure_catalog_id}><td>{row.procedure_name}</td><td>{row.category}</td><td>{row.units}</td><td>{row.patients}</td><td>{row.male}</td><td>{row.female}</td><td>{row.other}</td></tr>)}</tbody><tfoot><tr><th colSpan={2}>Overall (unique patients)</th><td>{data.units}</td><td>{data.patients}</td><td>{data.male}</td><td>{data.female}</td><td>{data.other}</td></tr></tfoot></table></div>
    {data.rows.length === 0 && <p>No structured procedure activity in this period.</p>}
  </section>
}

export function VisitProcedureSummary({ visit, correctionState }: { visit: Visit; correctionState: ReturnType<typeof useCorrections> }) {
  const [result, setResult] = useState<{ rows: PerformedProcedure[]; error: boolean; clinicId: string; visitId: string; corrections: typeof correctionState.rows } | null>(null)
  useEffect(() => {
    let cancelled=false
    async function load() {
      if (!procedureClient) { if (!cancelled) setResult({ rows: [], error: true, clinicId: visit.clinic_id, visitId: visit.id, corrections: correctionState.rows }); return }
      const response = await pagedResult(() => procedureClient!.from('performed_procedures').select('*').eq('clinic_id', visit.clinic_id).eq('visit_id', visit.id).order('recorded_at').order('id'))
      if (!cancelled) setResult({ rows: response.data ?? [], error: Boolean(response.error), clinicId: visit.clinic_id, visitId: visit.id, corrections: correctionState.rows })
    }
    void load()
    return () => { cancelled=true }
  }, [visit.clinic_id, visit.id, correctionState.rows])
  if (correctionState.error) return <p role="alert">Procedure summary unavailable; open details and refresh.</p>
  if (correctionState.loading || !result || result.clinicId!==visit.clinic_id || result.visitId!==visit.id || result.corrections!==correctionState.rows) return <p>Loading procedure summary...</p>
  if (result.error) return <p role="alert">Procedure summary unavailable; open details and refresh.</p>
  const effective = effectiveProcedures(result.rows).filter((row) => effectiveRecord(row, correctionState.rows, 'procedure'))
  return <p className="encounter-procedure-summary"><span>Procedures: </span>{effective.length ? effective.map((row) => row.procedure_name + (row.quantity > 1 ? ' x ' + row.quantity : '')).join(' / ') : 'No effective structured procedure recorded'}</p>
}
