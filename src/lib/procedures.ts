import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './supabase'

export interface ProcedureCatalog extends Record<string, unknown> {
  id: string; clinic_id: string; code: string; name: string; category: string
  active: boolean; created_at: string; created_by: string
}
export interface PerformedProcedure extends Record<string, unknown> {
  id: string; clinic_id: string; visit_id: string; procedure_catalog_id: string
  procedure_code: string; procedure_name: string; category: string; quantity: number
  tooth_number: number | null; note: string | null; performed_at: string
  clinical_author_id: string; recorded_by: string; recorded_at: string
  supersedes_id: string | null; correction_reason: string | null
}
export interface ProcedureTotals { units: number; records: number; patients: number; male: number; female: number; other: number }
export interface ProcedureActivity extends ProcedureTotals {
  rows: Array<ProcedureTotals & { procedure_catalog_id: string; procedure_code: string; procedure_name: string; category: string }>
}
type Table<Row> = { Row: Row; Insert: never; Update: never; Relationships: [] }
type ProcedureDatabase = { public: {
  Tables: { procedure_catalog: Table<ProcedureCatalog>; performed_procedures: Table<PerformedProcedure> }
  Views: Record<string, never>
  Functions: {
    record_performed_procedure: { Args: { p_visit_id: string; p_catalog_id: string; p_quantity: number; p_tooth_number: number | null; p_note: string | null; p_supersedes_id: string | null; p_reason: string | null }; Returns: PerformedProcedure }
    manage_procedure_catalog: { Args: { p_clinic_id: string; p_code: string; p_name: string; p_category: string; p_active: boolean }; Returns: ProcedureCatalog }
    install_dental_procedure_template: { Args: { p_clinic_id: string }; Returns: number }
    procedure_activity_report: { Args: { p_clinic_id: string; p_start_date: string; p_end_date: string }; Returns: ProcedureActivity }
  }
} }
export const procedureClient = supabase as unknown as SupabaseClient<ProcedureDatabase> | null
export function effectiveProcedures(rows: PerformedProcedure[]) {
  const replaced = new Set(rows.map((row) => row.supersedes_id).filter(Boolean))
  return rows.filter((row) => !replaced.has(row.id))
}
