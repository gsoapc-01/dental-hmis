import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type CorrectionKind = 'visit' | 'prescription' | 'investigation' | 'procedure' | 'dental'
export interface ClinicalCorrection extends Record<string, unknown> {
  id: string; clinic_id: string; visit_id: string; kind: CorrectionKind; record_id: string
  revision: number; predecessor_id: string | null; action: 'amend' | 'replace' | 'withdraw'
  snapshot: Record<string, string | number | null> | null; reason: string
  recorded_by: string; actor_display_name: string | null; recorded_at: string; admin_recovery: boolean
}
type DB = { public: { Tables: { clinical_corrections: { Row: ClinicalCorrection; Insert: never; Update: never; Relationships: [] } }; Views: Record<string, never>; Functions: {
  correct_clinical_record: { Args: { p_kind: CorrectionKind; p_record_id: string; p_action: string; p_expected_revision: number; p_snapshot: Record<string, string | number | null> | null; p_reason: string; p_admin_recovery: boolean }; Returns: ClinicalCorrection }
} } }
export const correctionClient = supabase as unknown as SupabaseClient<DB> | null
export async function loadCorrections(clinicId: string, visitId?: string) {
  if (!correctionClient) throw new Error('Supabase is not configured.')
  return readPages(() => {
    let query = correctionClient!.from('clinical_corrections').select('*').eq('clinic_id', clinicId)
    if (visitId) query = query.eq('visit_id', visitId)
    return query.order('id')
  })
}
// Advance by actual rows returned: also works when a server caps below 500.
export async function readPages<T>(query: () => { range: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> }) {
  const rows: T[] = []
  for (let offset = 0; ;) {
    const result = await query().range(offset, offset + 499)
    if (result.error) throw new Error(result.error.message)
    const page = result.data ?? []
    if (!page.length) return rows
    rows.push(...page); offset += page.length
  }
}
export async function pagedResult<T>(query: Parameters<typeof readPages<T>>[0]) {
  try { return { data: await readPages(query), error: null } }
  catch (failure) { return { data: null, error: { message: failure instanceof Error ? failure.message : 'Clinical history unavailable' } } }
}
export async function batchedResult<T>(ids: string[], query: (batch: string[]) => ReturnType<Parameters<typeof readPages<T>>[0]>) {
  try {
    const data: T[]=[]
    for (let start=0; start<ids.length; start+=100) data.push(...await readPages(() => query(ids.slice(start,start+100))))
    return { data,error:null }
  } catch (failure) { return { data:null,error:{ message: failure instanceof Error ? failure.message : 'Linked history unavailable' } } }
}
export function latestCorrection(rows: ClinicalCorrection[], kind: CorrectionKind, id: string) {
  return rows.filter((row) => row.kind === kind && row.record_id === id).sort((a, b) => b.revision - a.revision)[0]
}
export function effectiveRecord<T extends { id: string }>(original: T, rows: ClinicalCorrection[], kind: CorrectionKind): T | null {
  const latest = latestCorrection(rows, kind, original.id)
  if (latest?.action === 'withdraw') return null
  return latest?.snapshot ? { ...original, ...latest.snapshot } : original
}
