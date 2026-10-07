import { supabase } from './supabase'

export async function searchPatients(clinicId: string, text: string, page: number, size = 50) {
  if (!supabase) return { data: [], count: 0, error: { message: 'Supabase is not configured.' } }
  let query = supabase.from('patients').select('*', { count: 'exact' }).eq('clinic_id',clinicId)
  // Do not interpolate PostgREST syntax or wildcard characters from user input.
  const term = text.trim().replace(/[(),.%_*\\]/g,' ').replace(/\s+/g,' ').trim()
  if (term) query=query.or(['patient_number','first_name','middle_name','last_name','phone','email'].map((field) => `${field}.ilike.%${term}%`).join(','))
  return query.order('created_at',{ascending:false}).order('id').range((page-1)*size,page*size-1)
}
