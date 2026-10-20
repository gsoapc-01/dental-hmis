import { useEffect, useRef, useState } from 'react'
import { lifecycleClient, type ManagedClinic } from './lib/clinicLifecycle'
import { signOut } from './lib/auth'

export function OwnerClinics() {
  const [clinics, setClinics] = useState<ManagedClinic[]>([])
  const [name, setName] = useState('')
  const [adminId, setAdminId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  async function load() {
    const result = await lifecycleClient!.rpc('owner_list_clinics', {})
    if (result.error) { setClinics([]); setError('Clinic management is unavailable. Sign in again or contact support.'); return }
    setClinics(result.data ?? [])
  }
  useEffect(() => {
    let cancelled = false
    async function initialLoad() {
      try {
        const result = await lifecycleClient!.rpc('owner_list_clinics', {})
        if (cancelled) return
        if (result.error) { setError('Clinic management is unavailable. Sign in again or contact support.'); return }
        setClinics(result.data ?? [])
      } catch { if (!cancelled) setError('Clinic management could not be loaded. Try refreshing.') }
    }
    void initialLoad()
    return () => { cancelled = true }
  }, [])
  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await lifecycleClient!.rpc('owner_create_clinic', { p_name: name.trim(), p_admin_user_id: adminId.trim() })
      if (result.error) { setError(result.error.message); return }
      setName(''); setAdminId(''); await load()
    } catch { setError('Request failed. Refresh the clinic list before retrying creation.') }
    finally { lock.current = false; setBusy(false) }
  }
  async function transition(clinic: ManagedClinic) {
    if (lock.current) return
    const status = clinic.lifecycle_status === 'active' ? 'suspended' : 'active'
    if (!window.confirm(`${status === 'suspended' ? 'Suspend access to' : 'Activate'} ${clinic.name}?`)) return
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await lifecycleClient!.rpc('owner_set_clinic_status', { p_clinic_id: clinic.id, p_status: status })
      if (result.error) setError(result.error.message)
      await load()
    } catch { setError('Request failed. Refresh to confirm the current clinic status.') }
    finally { lock.current = false; setBusy(false) }
  }
  return <main className="auth-page"><section className="registration-panel">
    <h1>SoapSmile clinic management</h1>
    <p>Platform Owner · New clinics remain pending until activated.</p>
    <form className="auth-form" onSubmit={(event) => void create(event)}>
      <label>Clinic name<input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Initial administrator Auth user ID<input required pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" value={adminId} onChange={(e) => setAdminId(e.target.value)} /></label>
      <p>Use an existing confirmed account that has no clinic membership.</p>
      <button disabled={busy}>Create pending clinic</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={() => void load()}>Refresh</button>
    <table><thead><tr><th>Clinic</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {clinics.map((clinic) => <tr key={clinic.id}><td>{clinic.name}</td><td>{clinic.lifecycle_status}</td><td><button disabled={busy} onClick={() => void transition(clinic)}>{clinic.lifecycle_status === 'active' ? 'Suspend' : clinic.lifecycle_status === 'pending' ? 'Activate' : 'Reactivate'}</button></td></tr>)}
    </tbody></table>
    <button disabled={busy} onClick={() => void signOut().then((failure) => { if (failure) setError('Sign-out failed. Try again.') })}>Sign out</button>
  </section></main>
}
