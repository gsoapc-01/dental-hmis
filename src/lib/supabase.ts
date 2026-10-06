import { createClient as _createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

import type {
  AuditLog,
  Appointment,
  Clinic,
  ClinicMembership,
  DentalChartEntry,
  EncounterContext,
  Invoice,
  Investigation,
  Patient,
  Payment,
  Prescription,
  Profile,
  StandaloneVisitLifecycle,
  UserRole,
  Visit,
} from '../types/domain'
import { env } from '../config/env'

export interface Database {
  public: {
    Tables: {
      standalone_visit_lifecycle: { Row: StandaloneVisitLifecycle; Insert: never; Update: never }
      encounter_contexts: { Row: EncounterContext; Insert: never; Update: never }
      clinics: { Row: Clinic; Insert: Omit<Clinic, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Clinic> }
      profiles: { Row: Profile; Insert: Omit<Profile, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Profile> }
      clinic_memberships: { Row: ClinicMembership; Insert: Omit<ClinicMembership, 'created_at' | 'is_active'> & { is_active?: boolean }; Update: Partial<ClinicMembership> }
      patients: { Row: Patient; Insert: Omit<Patient, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Patient> }
      appointments: { Row: Appointment; Insert: never; Update: Partial<Appointment> }
      visits: { Row: Visit; Insert: Omit<Visit, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Visit> }
      dental_chart_entries: { Row: DentalChartEntry; Insert: Omit<DentalChartEntry, 'id' | 'created_at' | 'supersedes_entry_id' | 'correction_reason'>; Update: never }
      prescriptions: { Row: Prescription; Insert: Omit<Prescription, 'id' | 'created_at'>; Update: Partial<Prescription> }
      investigations: { Row: Investigation; Insert: Omit<Investigation, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Investigation> }
      invoices: { Row: Invoice; Insert: Omit<Invoice, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Invoice> }
      payments: { Row: Payment; Insert: Omit<Payment, 'id' | 'created_at'>; Update: Partial<Payment> }
      audit_logs: { Row: AuditLog; Insert: never; Update: never }
    }
    Views: Record<string, never>
    Functions: {
      finalize_standalone_visit: { Args: { p_visit_id: string }; Returns: StandaloneVisitLifecycle }
      start_encounter_context: {
        Args: { p_clinic_id: string; p_patient_id: string }
        Returns: EncounterContext
      }
      book_encounter_appointment: {
        Args: { p_encounter_id: string; p_patient_id: string; p_doctor_id: string; p_appointment_date: string; p_start_time: string; p_end_time: string; p_service: string | null; p_notes: string | null }
        Returns: Appointment
      }
      correct_dental_chart_entry: {
        Args: { p_entry_id: string; p_surfaces: string[]; p_finding: string | null; p_procedure_text: string | null; p_notes: string | null; p_reason: string }
        Returns: DentalChartEntry
      }
      exit_appointment_queue: {
        Args: { p_appointment_id: string; p_status: 'cancelled' | 'no_show'; p_reason: string }
        Returns: Appointment
      }
      bootstrap_clinic: {
        Args: { p_name: string }
        Returns: string
      }
      update_clinic_currency: {
        Args: { p_clinic_id: string; p_currency: string }
        Returns: Clinic
      }
      admin_change_clinic_staff_role: {
        Args: { p_clinic_id: string; p_target_user_id: string; p_new_role: UserRole }
        Returns: ClinicMembership
      }
      admin_set_clinic_staff_active: {
        Args: { p_clinic_id: string; p_target_user_id: string; p_is_active: boolean }
        Returns: ClinicMembership
      }
      start_consultation: {
        Args: { p_appointment_id: string }
        Returns: Visit
      }
      save_consultation: {
        Args: {
          p_visit_id: string
          p_chief_complaint: string | null
          p_hpi: string | null
          p_examination: string | null
          p_assessment: string | null
          p_treatment_plan: string | null
          p_clinical_notes: string | null
          p_follow_up_date: string | null
          p_follow_up_instructions: string | null
        }
        Returns: Visit
      }
      complete_consultation: {
        Args: {
          p_visit_id: string
          p_chief_complaint: string | null
          p_hpi: string | null
          p_examination: string | null
          p_assessment: string | null
          p_treatment_plan: string | null
          p_clinical_notes: string | null
          p_follow_up_date: string | null
          p_follow_up_instructions: string | null
        }
        Returns: Visit
      }
      create_invoice: {
        Args: { p_clinic_id: string; p_patient_id: string; p_visit_id: string | null; p_total: number }
        Returns: Invoice
      }
      record_payment: {
        Args: { p_invoice_id: string; p_amount: number; p_payment_method: string; p_reference: string | null }
        Returns: Payment
      }
    }
    Enums: Record<string, never>
  }
}

const url = env.SUPABASE_URL ?? ''
const key = env.SUPABASE_PUBLISHABLE_KEY ?? ''

export const supabase: SupabaseClient<Database> | null = isConfigured()
  ? _createClient<Database>(url, key)
  : null

export type { SupabaseClient }

// A bounded RPC schema keeps this workflow typed without changing legacy table typing.
type DentalCorrectionDatabase = { public: { Tables: Record<string, never>; Views: Record<string, never>; Functions: Pick<Database['public']['Functions'], 'correct_dental_chart_entry'> } }
export function correctDentalChartEntry(args: Database['public']['Functions']['correct_dental_chart_entry']['Args']) {
  if (!supabase) throw new Error('Supabase is not configured.')
  return (supabase as unknown as SupabaseClient<DentalCorrectionDatabase>).rpc('correct_dental_chart_entry', args)
}

type EncounterWorkflowDatabase = { public: { Tables: Record<string, never>; Views: Record<string, never>; Functions: Pick<Database['public']['Functions'], 'start_encounter_context' | 'book_encounter_appointment'> } }
export function startEncounterContext(args: Database['public']['Functions']['start_encounter_context']['Args']) {
  if (!supabase) throw new Error('Supabase is not configured.')
  return (supabase as unknown as SupabaseClient<EncounterWorkflowDatabase>).rpc('start_encounter_context', args)
}
export function bookEncounterAppointment(args: Database['public']['Functions']['book_encounter_appointment']['Args']) {
  if (!supabase) throw new Error('Supabase is not configured.')
  return (supabase as unknown as SupabaseClient<EncounterWorkflowDatabase>).rpc('book_encounter_appointment', args)
}

export function isConfigured(): boolean {
  return env.SUPABASE_URL !== null && env.SUPABASE_PUBLISHABLE_KEY !== null
}
