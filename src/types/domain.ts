export type JsonPrimitive = string | number | boolean | null
export type JsonObject = { [key: string]: JsonValue }
export type JsonArray = JsonValue[]
export type JsonValue = JsonPrimitive | JsonObject | JsonArray

export type UserRole = 'admin' | 'doctor' | 'receptionist' | 'patient'

export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'arrived'
  | 'waiting'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show'

export type InvoiceStatus =
  | 'draft'
  | 'partially_paid'
  | 'paid'
  | 'cancelled'
  | 'void'

export type PaymentMethod =
  | 'cash'
  | 'mobile_money'
  | 'card'
  | 'bank'
  | 'insurance'
  | 'other'

export interface Clinic {
  id: string
  name: string
  logo_url?: string | null
  favicon_url?: string | null
  primary_color?: string | null
  secondary_color?: string | null
  accent_color?: string | null
  address?: string | null
  phone?: string | null
  email?: string | null
  website?: string | null
  whatsapp?: string | null
  tagline?: string | null
  currency: string
  timezone: string
  created_at: string
  updated_at: string
}

export interface Profile {
  id: string
  display_name?: string | null
  avatar_url?: string | null
  created_at: string
  updated_at: string
}

export interface ClinicMembership {
  user_id: string
  clinic_id: string
  role: UserRole
  created_at: string
}

export interface Patient {
  id: string
  clinic_id: string
  patient_number: string
  first_name: string
  middle_name?: string | null
  last_name: string
  date_of_birth?: string | null
  gender?: string | null
  national_id?: string | null
  phone?: string | null
  whatsapp?: string | null
  email?: string | null
  address?: string | null
  emergency_contact_name?: string | null
  emergency_contact_relationship?: string | null
  emergency_contact_phone?: string | null
  nationality?: string | null
  occupation?: string | null
  marital_status?: string | null
  preferred_language?: string | null
  allergies?: string | null
  current_medications?: string | null
  medical_history?: string | null
  previous_surgery?: string | null
  family_history?: string | null
  dental_history?: string | null
  relevant_habits?: string | null
  pregnancy_status?: string | null
  created_at: string
  updated_at: string
}

export interface Appointment {
  id: string
  clinic_id: string
  patient_id: string
  doctor_id?: string | null
  created_by?: string | null
  appointment_date: string
  start_time: string
  end_time: string
  service?: string | null
  notes?: string | null
  status: AppointmentStatus
  created_at: string
  updated_at: string
}

export interface Visit {
  id: string
  clinic_id: string
  patient_id: string
  doctor_id: string
  appointment_id?: string | null
  visit_date: string
  chief_complaint?: string | null
  hpi?: string | null
  vital_signs?: JsonValue | null
  examination?: string | null
  assessment?: string | null
  treatment_plan?: string | null
  clinical_notes?: string | null
  follow_up_date?: string | null
  follow_up_instructions?: string | null
  created_at: string
  updated_at: string
}

export interface Prescription {
  id: string
  clinic_id: string
  patient_id: string
  visit_id: string
  prescribing_doctor_id: string
  medicine: string
  strength?: string | null
  dose?: string | null
  route?: string | null
  frequency?: string | null
  duration?: string | null
  quantity?: number | null
  instructions?: string | null
  created_at: string
}

export interface Investigation {
  id: string
  clinic_id: string
  patient_id: string
  visit_id: string
  requesting_doctor_id: string
  investigation_type: string
  status?: string | null
  result?: string | null
  result_date?: string | null
  notes?: string | null
  created_at: string
  updated_at: string
}

export interface Invoice {
  id: string
  clinic_id: string
  patient_id: string
  visit_id?: string | null
  invoice_number: string
  status: InvoiceStatus
  subtotal: number
  discount: number
  total: number
  amount_paid: number
  balance: number
  currency: string
  created_at: string
  updated_at: string
}

export interface Payment {
  id: string
  clinic_id: string
  invoice_id: string
  patient_id: string
  recorded_by?: string | null
  payment_method: PaymentMethod
  amount: number
  reference?: string | null
  payment_date: string
  created_at: string
}

export interface AuditLog {
  id: string
  clinic_id?: string | null
  actor_user_id?: string | null
  table_name?: string | null
  record_id?: string | null
  action?: string | null
  old_data?: JsonValue | null
  new_data?: JsonValue | null
  metadata?: JsonValue | null
  created_at: string
}
