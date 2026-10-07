import { useRef, useState } from 'react'
import { supabase } from './lib/supabase'

export function PasswordRecovery() {
  const [email,setEmail] = useState('')
  const [busy,setBusy] = useState(false)
  const [message,setMessage] = useState('')
  async function send(event: React.FormEvent) {
    event.preventDefault()
    if (!supabase || busy) return
    setBusy(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(),{ redirectTo: window.location.origin + window.location.pathname + '?password_setup=1' })
    setMessage(error ? 'Recovery could not be requested. Please try again.' : 'If this email has an account, a password recovery link has been sent.')
    setBusy(false)
  }
  return <details><summary>Forgot password / need a new access link?</summary><form onSubmit={(event) => void send(event)}><label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><button type="submit" disabled={busy}>{busy ? 'Sending...' : 'Send recovery link'}</button><p role="status">{message}</p></form></details>
}

export function PasswordEstablishment({ authenticated, onComplete }: { authenticated: boolean; onComplete: () => void }) {
  const [password,setPassword] = useState('')
  const [confirmation,setConfirmation] = useState('')
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const lock = useRef(false)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!supabase || lock.current) return
    if (password !== confirmation) { setError('Passwords must match.'); return }
    lock.current=true; setBusy(true); setError('')
    const result = await supabase.auth.updateUser({ password })
    if (result.error) setError(result.error.message)
    else {
      // Require a normal password login after establishment; never enter clinic
      // setup on an invalid invitation or recovery callback.
      const logout = await supabase.auth.signOut()
      if (logout.error) setError('Password saved. Sign-out failed; please try again.')
      else { setPassword(''); setConfirmation(''); onComplete() }
    }
    lock.current=false; setBusy(false)
  }
  return <main className="auth-page"><section className="auth-panel"><h1>Set your password</h1>{authenticated ? <><p>Establish your clinic credentials, then sign in with your email and password.</p><form className="auth-form" onSubmit={(event) => void save(event)}><label>New password<input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>Confirm password<input type="password" autoComplete="new-password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save password and sign out'}</button></form></> : <><p>This access link is invalid or expired. Request a new recovery link or ask your administrator to resend the invitation.</p><PasswordRecovery /></>}{error && <p role="alert">{error}</p>}<button type="button" className="button-secondary" disabled={busy} onClick={() => { void (async () => { const result=await supabase?.auth.signOut(); if (result?.error) setError('Sign-out failed. Please try again.'); else onComplete() })() }}>Back to sign in</button></section></main>
}
