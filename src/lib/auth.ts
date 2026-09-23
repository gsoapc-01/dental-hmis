import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js'

import { supabase } from './supabase'

export type AuthResult = {
  user: User | null
  error: Error | null
}

export async function getCurrentSession(): Promise<{
  session: Session | null
  error: Error | null
}> {
  if (!supabase) return { session: null, error: new Error('Supabase is not configured.') }

  const { data, error } = await supabase.auth.getSession()
  return { session: data.session, error: error ? new Error(error.message) : null }
}

export function subscribeToAuthChanges(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
): () => void {
  if (!supabase) return () => undefined

  const { data } = supabase.auth.onAuthStateChange(callback)
  return () => data.subscription.unsubscribe()
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { user: null, error: new Error('Supabase is not configured.') }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  return { user: data.user, error: error ? new Error(error.message) : null }
}

export async function signOut(): Promise<Error | null> {
  if (!supabase) return new Error('Supabase is not configured.')

  const { error } = await supabase.auth.signOut()
  return error ? new Error(error.message) : null
}