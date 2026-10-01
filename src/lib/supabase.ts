import { createClient as _createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

import type {
  AuditLog,
  Appointment,
  Clinic,
  ClinicMembership,
  DentalChartEntry,
  Invoice,
  Investigation,
  Patient,
  Payment,
  Prescription,
  Profile,
  UserRole,
  Visit,
} from '../types/domain'
import { env } from '../config/env'

export interface Database {
  public: {
    Tables: {
      clinics: { Row: Clinic; Insert: Omit<Clinic, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Clinic> }
      profiles: { Row: Profile; Insert: Omit<Profile, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Profile> }
      clinic_memberships: { Row: ClinicMembership; Insert: Omit<ClinicMembership, 'created_at' | 'is_active'> & { is_active?: boolean }; Update: Partial<ClinicMembership> }
      patients: { Row: Patient; Insert: Omit<Patient, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Patient> }
      appointments: { Row: Appointment; Insert: Omit<Appointment, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Appointment> }
      visits: { Row: Visit; Insert: Omit<Visit, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Visit> }
      dental_chart_entries: { Row: DentalChartEntry; Insert: Omit<DentalChartEntry, 'id' | 'created_at'>; Update: Partial<DentalChartEntry> }
      prescriptions: { Row: Prescription; Insert: Omit<Prescription, 'id' | 'created_at'>; Update: Partial<Prescription> }
      investigations: { Row: Investigation; Insert: Omit<Investigation, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Investigation> }
      invoices: { Row: Invoice; Insert: Omit<Invoice, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Invoice> }
      payments: { Row: Payment; Insert: Omit<Payment, 'id' | 'created_at'>; Update: Partial<Payment> }
      audit_logs: { Row: AuditLog; Insert: Omit<AuditLog, 'id' | 'created_at'>; Update: Partial<AuditLog> }
    }
    Views: Record<string, never>
    Functions: {
      bootstrap_clinic: {
        Args: { p_name: string }
        Returns: string
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

export function isConfigured(): boolean {
  return env.SUPABASE_URL !== null && env.SUPABASE_PUBLISHABLE_KEY !== null
}
