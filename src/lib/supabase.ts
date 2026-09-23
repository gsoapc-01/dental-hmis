import { createClient as _createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

import type {
  AuditLog,
  Appointment,
  Clinic,
  ClinicMembership,
  Invoice,
  Investigation,
  Patient,
  Payment,
  Prescription,
  Profile,
  Visit,
} from '../types/domain'
import { env } from '../config/env'

export interface Database {
  public: {
    Tables: {
      clinics: { Row: Clinic; Insert: Omit<Clinic, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Clinic> }
      profiles: { Row: Profile; Insert: Omit<Profile, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Profile> }
      clinic_memberships: { Row: ClinicMembership; Insert: Omit<ClinicMembership, 'created_at'>; Update: Partial<ClinicMembership> }
      patients: { Row: Patient; Insert: Omit<Patient, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Patient> }
      appointments: { Row: Appointment; Insert: Omit<Appointment, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Appointment> }
      visits: { Row: Visit; Insert: Omit<Visit, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Visit> }
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
