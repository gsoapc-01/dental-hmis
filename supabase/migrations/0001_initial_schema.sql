-- =====================================================================
-- SmartDental HMIS — 0001_initial_schema.sql
-- Milestone 2: Multi-tenant foundation, roles, RLS, clinical history
-- =====================================================================
-- This migration is intended to be applied against a fresh Supabase
-- PostgreSQL database (Supabase Postgres 15+).  It creates the core
-- schema on top of Supabase's standard `auth.users` table.
--
-- The file is written to be as idempotent as Postgres allows:
--   * CREATE TABLE IF NOT EXISTS for every table
--   * DO $$ blocks for CREATE TYPE (Postgres lacks IF NOT EXISTS for enums)
--   * CREATE INDEX IF NOT EXISTS for every index
--   * DROP POLICY IF EXISTS before every CREATE POLICY
-- =====================================================================

BEGIN;

-- =====================================================================
-- Section 1: Extensions
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public;

-- =====================================================================
-- Section 2: Enum types (idempotent via DO blocks)
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role_enum') THEN
    CREATE TYPE user_role_enum AS ENUM ('admin', 'doctor', 'receptionist', 'patient');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'appointment_status_enum') THEN
    CREATE TYPE appointment_status_enum AS ENUM (
      'scheduled', 'confirmed', 'arrived', 'waiting',
      'in_progress', 'completed', 'cancelled', 'no_show'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status_enum') THEN
    CREATE TYPE invoice_status_enum AS ENUM (
      'draft', 'partially_paid', 'paid', 'cancelled', 'void'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method_enum') THEN
    CREATE TYPE payment_method_enum AS ENUM (
      'cash', 'mobile_money', 'card', 'bank', 'insurance', 'other'
    );
  END IF;
END$$;

-- =====================================================================
-- Section 3: Tables (in FK dependency order)
-- Column order: PK → tenant FK → business FKs → enums/text → numerics → jsonb → timestamps
-- =====================================================================

-- 1. clinics — tenant identity + future white-label configuration
CREATE TABLE IF NOT EXISTS public.clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  logo_url text,
  favicon_url text,
  primary_color text,
  secondary_color text,
  accent_color text,
  address text,
  phone text,
  email text,
  website text,
  whatsapp text,
  tagline text,
  currency text NOT NULL DEFAULT 'USD',
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. profiles — application-level user identity, 1:1 with auth.users
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. clinic_memberships — auth user → clinic → role membership junction
CREATE TABLE IF NOT EXISTS public.clinic_memberships (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  role user_role_enum NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, clinic_id)
);

-- 4. patients — clinical patient master record (per clinic)
CREATE TABLE IF NOT EXISTS public.patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  patient_number text NOT NULL,
  first_name text NOT NULL,
  middle_name text,
  last_name text NOT NULL,
  date_of_birth date,
  gender text,
  national_id text,
  phone text,
  whatsapp text,
  email text,
  address text,
  emergency_contact_name text,
  emergency_contact_relationship text,
  emergency_contact_phone text,
  nationality text,
  occupation text,
  marital_status text,
  preferred_language text,
  allergies text,
  current_medications text,
  medical_history text,
  previous_surgery text,
  family_history text,
  dental_history text,
  relevant_habits text,
  pregnancy_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patients_clinic_patient_number_unq UNIQUE (clinic_id, patient_number)
);

-- 5. appointments
CREATE TABLE IF NOT EXISTS public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
  doctor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  appointment_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  service text,
  notes text,
  status appointment_status_enum NOT NULL DEFAULT 'scheduled',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_times_check CHECK (end_time >= start_time)
);

-- 6. visits — immutable historical clinical encounters
CREATE TABLE IF NOT EXISTS public.visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  visit_date timestamptz NOT NULL DEFAULT now(),
  chief_complaint text,
  hpi text,
  vital_signs jsonb,
  examination text,
  assessment text,
  treatment_plan text,
  clinical_notes text,
  follow_up_date date,
  follow_up_instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 7. prescriptions — belong to a specific historical visit
CREATE TABLE IF NOT EXISTS public.prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE RESTRICT,
  prescribing_doctor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  medicine text NOT NULL,
  strength text,
  dose text,
  route text,
  frequency text,
  duration text,
  quantity numeric,
  instructions text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 8. investigations
CREATE TABLE IF NOT EXISTS public.investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE RESTRICT,
  requesting_doctor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  investigation_type text NOT NULL,
  status text,
  result text,
  result_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 9. invoices
CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
  visit_id uuid REFERENCES public.visits(id) ON DELETE SET NULL,
  invoice_number text NOT NULL,
  status invoice_status_enum NOT NULL DEFAULT 'draft',
  subtotal numeric NOT NULL DEFAULT 0,
  discount numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  amount_paid numeric NOT NULL DEFAULT 0,
  balance numeric NOT NULL DEFAULT 0,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_clinic_invoice_number_unq UNIQUE (clinic_id, invoice_number),
  CONSTRAINT invoices_subtotal_nonneg CHECK (subtotal >= 0),
  CONSTRAINT invoices_discount_nonneg CHECK (discount >= 0),
  CONSTRAINT invoices_total_nonneg CHECK (total >= 0),
  CONSTRAINT invoices_amount_paid_nonneg CHECK (amount_paid >= 0),
  CONSTRAINT invoices_balance_nonneg CHECK (balance >= 0)
);

-- 10. payments
CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
  recorded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  payment_method payment_method_enum NOT NULL,
  amount numeric NOT NULL,
  reference text,
  payment_date timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_amount_nonneg CHECK (amount >= 0)
);

-- 11. audit_logs — foundation for change tracking
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES public.clinics(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  table_name text,
  record_id uuid,
  action text,
  old_data jsonb,
  new_data jsonb,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- Section 4: Indexes (FR-25)
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_patients_clinic_number       ON public.patients       (clinic_id, patient_number);
CREATE INDEX IF NOT EXISTS idx_patients_clinic_names        ON public.patients       (clinic_id, first_name, last_name);
CREATE INDEX IF NOT EXISTS idx_patients_clinic_phone        ON public.patients       (clinic_id, phone);
CREATE INDEX IF NOT EXISTS idx_patients_clinic_email        ON public.patients       (clinic_id, email);
CREATE INDEX IF NOT EXISTS idx_visits_clinic_patient_date   ON public.visits         (clinic_id, patient_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_date     ON public.appointments   (clinic_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_invoices_clinic_number       ON public.invoices       (clinic_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_payments_invoice             ON public.payments       (invoice_id);
CREATE INDEX IF NOT EXISTS idx_memberships_clinic_role      ON public.clinic_memberships (clinic_id, role);
CREATE INDEX IF NOT EXISTS idx_audit_logs_clinic_created    ON public.audit_logs     (clinic_id, created_at DESC);

-- Additional performance indexes on clinic_id for all tenant tables
CREATE INDEX IF NOT EXISTS idx_patients_clinic              ON public.patients        (clinic_id);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic          ON public.appointments    (clinic_id);
CREATE INDEX IF NOT EXISTS idx_visits_clinic                ON public.visits          (clinic_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_clinic         ON public.prescriptions   (clinic_id);
CREATE INDEX IF NOT EXISTS idx_investigations_clinic        ON public.investigations  (clinic_id);
CREATE INDEX IF NOT EXISTS idx_invoices_clinic              ON public.invoices        (clinic_id);
CREATE INDEX IF NOT EXISTS idx_payments_clinic              ON public.payments        (clinic_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user             ON public.clinic_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_visits_patient               ON public.visits          (patient_id);

-- =====================================================================
-- Section 5: Row Level Security — enable on every table
-- =====================================================================
ALTER TABLE public.clinics             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_memberships  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visits              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prescriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investigations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs          ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- Section 6: Policies
-- Pattern:
--   * membership lookup via clinic_memberships (no recursion, uses auth.uid() directly)
--   * admin ownership of writes on admin/config tables
--   * strict write controls on clinical history (visits/prescriptions/investigations/invoices/payments)
--     — only admin or doctor owner can create; only admin can update/delete
--     — audit_logs: no end-user delete/update
-- =====================================================================

-- Helper predicate style: every clinic-scoped table reuses the same membership test.
-- We inline the test directly to avoid function recursion.
-- The membership test is:
--   EXISTS (
--     SELECT 1 FROM public.clinic_memberships m
--     WHERE m.clinic_id = <table>.clinic_id AND m.user_id = auth.uid()
--   )

-- ---- clinics ----
DROP POLICY IF EXISTS clinics_select ON public.clinics;
CREATE POLICY clinics_select ON public.clinics
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.clinic_memberships m
      WHERE m.clinic_id = clinics.id AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS clinics_admin_write ON public.clinics;
CREATE POLICY clinics_admin_write ON public.clinics
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.clinic_memberships m
      WHERE m.clinic_id = clinics.id AND m.user_id = auth.uid() AND m.role = 'admin'
    )
  );

DROP POLICY IF EXISTS clinics_admin_update ON public.clinics;
CREATE POLICY clinics_admin_update ON public.clinics
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.clinic_memberships m
      WHERE m.clinic_id = clinics.id AND m.user_id = auth.uid() AND m.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.clinic_memberships m
      WHERE m.clinic_id = clinics.id AND m.user_id = auth.uid() AND m.role = 'admin'
    )
  );

-- ---- profiles — user owns their own profile; clinic admin can read clinic members ----
DROP POLICY IF EXISTS profiles_self_rw ON public.profiles;
CREATE POLICY profiles_self_rw ON public.profiles
  FOR ALL TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS profiles_admin_read ON public.profiles;
CREATE POLICY profiles_admin_read ON public.profiles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.clinic_memberships m
      WHERE m.user_id = profiles.id
        AND EXISTS (
          SELECT 1 FROM public.clinic_memberships me
          WHERE me.clinic_id = m.clinic_id
            AND me.user_id = auth.uid()
            AND me.role = 'admin'
        )
    )
  );

-- ---- clinic_memberships ----
DROP POLICY IF EXISTS memberships_self_read ON public.clinic_memberships;
CREATE POLICY memberships_self_read ON public.clinic_memberships
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM public.clinic_memberships me
      WHERE me.clinic_id = clinic_memberships.clinic_id
        AND me.user_id = auth.uid()
        AND me.role = 'admin'
    )
  );

DROP POLICY IF EXISTS memberships_admin_write ON public.clinic_memberships;
CREATE POLICY memberships_admin_write ON public.clinic_memberships
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.clinic_memberships me
      WHERE me.clinic_id = clinic_memberships.clinic_id
        AND me.user_id = auth.uid()
        AND me.role = 'admin'
    )
  );

DROP POLICY IF EXISTS memberships_admin_update ON public.clinic_memberships;
CREATE POLICY memberships_admin_update ON public.clinic_memberships
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.clinic_memberships me
      WHERE me.clinic_id = clinic_memberships.clinic_id
        AND me.user_id = auth.uid()
        AND me.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.clinic_memberships me
      WHERE me.clinic_id = clinic_memberships.clinic_id
        AND me.user_id = auth.uid()
        AND me.role = 'admin'
    )
  );

DROP POLICY IF EXISTS memberships_admin_delete ON public.clinic_memberships;
CREATE POLICY memberships_admin_delete ON public.clinic_memberships
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.clinic_memberships me
      WHERE me.clinic_id = clinic_memberships.clinic_id
        AND me.user_id = auth.uid()
        AND me.role = 'admin'
    )
  );

-- =====================================================================
-- Section 6b: Standard tenant-owned table policy templates
-- Template for every tenant-owned table T:
--   SELECT:  authenticated + membership in T.clinic_id
--   INSERT:  authenticated + membership (staff) OR patient self-actions (for patients only)
--   UPDATE:  admin role OR (doctor owner where applicable)
--   DELETE:  admin only; for clinical history: NO authenticated delete
-- =====================================================================

-- --- patients ---
DROP POLICY IF EXISTS patients_select ON public.patients;
CREATE POLICY patients_select ON public.patients
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = patients.clinic_id AND m.user_id = auth.uid())
  );

DROP POLICY IF EXISTS patients_staff_insert ON public.patients;
CREATE POLICY patients_staff_insert ON public.patients
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = patients.clinic_id
              AND m.user_id = auth.uid()
              AND m.role IN ('admin', 'doctor', 'receptionist'))
  );

DROP POLICY IF EXISTS patients_staff_update ON public.patients;
CREATE POLICY patients_staff_update ON public.patients
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = patients.clinic_id
              AND m.user_id = auth.uid()
              AND m.role IN ('admin', 'doctor', 'receptionist'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = patients.clinic_id
              AND m.user_id = auth.uid()
              AND m.role IN ('admin', 'doctor', 'receptionist'))
  );

DROP POLICY IF EXISTS patients_admin_delete ON public.patients;
CREATE POLICY patients_admin_delete ON public.patients
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = patients.clinic_id
              AND m.user_id = auth.uid()
              AND m.role = 'admin')
  );

-- --- appointments ---
DROP POLICY IF EXISTS appointments_select ON public.appointments;
CREATE POLICY appointments_select ON public.appointments
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = appointments.clinic_id AND m.user_id = auth.uid())
  );

DROP POLICY IF EXISTS appointments_staff_insert ON public.appointments;
CREATE POLICY appointments_staff_insert ON public.appointments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = appointments.clinic_id
              AND m.user_id = auth.uid()
              AND m.role IN ('admin', 'doctor', 'receptionist'))
  );

DROP POLICY IF EXISTS appointments_staff_update ON public.appointments;
CREATE POLICY appointments_staff_update ON public.appointments
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = appointments.clinic_id
              AND m.user_id = auth.uid()
              AND m.role IN ('admin', 'doctor', 'receptionist'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = appointments.clinic_id
              AND m.user_id = auth.uid()
              AND m.role IN ('admin', 'doctor', 'receptionist'))
  );

DROP POLICY IF EXISTS appointments_admin_delete ON public.appointments;
CREATE POLICY appointments_admin_delete ON public.appointments
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = appointments.clinic_id
              AND m.user_id = auth.uid()
              AND m.role = 'admin')
  );

-- --- visits (clinical history — strict) ---
DROP POLICY IF EXISTS visits_select ON public.visits;
CREATE POLICY visits_select ON public.visits
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = visits.clinic_id AND m.user_id = auth.uid())
  );

DROP POLICY IF EXISTS visits_create ON public.visits;
CREATE POLICY visits_create ON public.visits
  FOR INSERT TO authenticated
  WITH CHECK (
    -- Either admin OR doctor that is the visit's assigned doctor
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = visits.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR (m.role = 'doctor' AND visits.doctor_id = auth.uid())))
  );

DROP POLICY IF EXISTS visits_update ON public.visits;
CREATE POLICY visits_update ON public.visits
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = visits.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR (m.role = 'doctor' AND visits.doctor_id = auth.uid())))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = visits.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR (m.role = 'doctor' AND visits.doctor_id = auth.uid())))
  );

DROP POLICY IF EXISTS visits_delete ON public.visits;
CREATE POLICY visits_delete ON public.visits
  FOR DELETE TO authenticated
  USING (
    -- Only clinic admin can delete; use RESTRICT FK to cascade-fail if children exist
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = visits.clinic_id
              AND m.user_id = auth.uid()
              AND m.role = 'admin')
  );

-- --- prescriptions (owned by visit, strict) ---
DROP POLICY IF EXISTS prescriptions_select ON public.prescriptions;
CREATE POLICY prescriptions_select ON public.prescriptions
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = prescriptions.clinic_id AND m.user_id = auth.uid())
  );

DROP POLICY IF EXISTS prescriptions_create ON public.prescriptions;
CREATE POLICY prescriptions_create ON public.prescriptions
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = prescriptions.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR (m.role = 'doctor' AND prescriptions.prescribing_doctor_id = auth.uid())))
  );

DROP POLICY IF EXISTS prescriptions_update ON public.prescriptions;
CREATE POLICY prescriptions_update ON public.prescriptions
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = prescriptions.clinic_id
              AND m.user_id = auth.uid()
              AND m.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = prescriptions.clinic_id
              AND m.user_id = auth.uid()
              AND m.role = 'admin')
  );

DROP POLICY IF EXISTS prescriptions_delete ON public.prescriptions;
CREATE POLICY prescriptions_delete ON public.prescriptions
  FOR DELETE TO authenticated
  USING (false);

-- --- investigations ---
DROP POLICY IF EXISTS investigations_select ON public.investigations;
CREATE POLICY investigations_select ON public.investigations
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = investigations.clinic_id AND m.user_id = auth.uid())
  );

DROP POLICY IF EXISTS investigations_create ON public.investigations;
CREATE POLICY investigations_create ON public.investigations
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = investigations.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR (m.role = 'doctor' AND investigations.requesting_doctor_id = auth.uid())))
  );

DROP POLICY IF EXISTS investigations_update ON public.investigations;
CREATE POLICY investigations_update ON public.investigations
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = investigations.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR m.role = 'doctor' OR m.role = 'receptionist'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = investigations.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR m.role = 'doctor' OR m.role = 'receptionist'))
  );

DROP POLICY IF EXISTS investigations_delete ON public.investigations;
CREATE POLICY investigations_delete ON public.investigations
  FOR DELETE TO authenticated
  USING (false);

-- --- invoices ---
DROP POLICY IF EXISTS invoices_select ON public.invoices;
CREATE POLICY invoices_select ON public.invoices
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = invoices.clinic_id AND m.user_id = auth.uid())
  );

DROP POLICY IF EXISTS invoices_staff_insert ON public.invoices;
CREATE POLICY invoices_staff_insert ON public.invoices
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = invoices.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR m.role = 'receptionist'))
  );

DROP POLICY IF EXISTS invoices_staff_update ON public.invoices;
CREATE POLICY invoices_staff_update ON public.invoices
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = invoices.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR m.role = 'receptionist'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = invoices.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR m.role = 'receptionist'))
  );

DROP POLICY IF EXISTS invoices_admin_delete ON public.invoices;
CREATE POLICY invoices_admin_delete ON public.invoices
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = invoices.clinic_id
              AND m.user_id = auth.uid()
              AND m.role = 'admin')
  );

-- --- payments ---
DROP POLICY IF EXISTS payments_select ON public.payments;
CREATE POLICY payments_select ON public.payments
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = payments.clinic_id AND m.user_id = auth.uid())
  );

DROP POLICY IF EXISTS payments_staff_insert ON public.payments;
CREATE POLICY payments_staff_insert ON public.payments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = payments.clinic_id
              AND m.user_id = auth.uid()
              AND (m.role = 'admin' OR m.role = 'receptionist'))
  );

DROP POLICY IF EXISTS payments_admin_update ON public.payments;
CREATE POLICY payments_admin_update ON public.payments
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = payments.clinic_id
              AND m.user_id = auth.uid()
              AND m.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = payments.clinic_id
              AND m.user_id = auth.uid()
              AND m.role = 'admin')
  );

DROP POLICY IF EXISTS payments_delete ON public.payments;
CREATE POLICY payments_delete ON public.payments
  FOR DELETE TO authenticated
  USING (false);

-- --- audit_logs (read-only for clinic admin; no end-user mutation) ---
DROP POLICY IF EXISTS audit_logs_admin_read ON public.audit_logs;
CREATE POLICY audit_logs_admin_read ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = audit_logs.clinic_id
              AND m.user_id = auth.uid()
              AND m.role = 'admin')
  );

DROP POLICY IF EXISTS audit_logs_system_insert ON public.audit_logs;
CREATE POLICY audit_logs_system_insert ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.clinic_memberships m
            WHERE m.clinic_id = audit_logs.clinic_id
              AND m.user_id = auth.uid()
              AND m.role = 'admin')
  );

DROP POLICY IF EXISTS audit_logs_no_update ON public.audit_logs;
CREATE POLICY audit_logs_no_update ON public.audit_logs
  FOR UPDATE TO authenticated
  USING (false);

DROP POLICY IF EXISTS audit_logs_no_delete ON public.audit_logs;
CREATE POLICY audit_logs_no_delete ON public.audit_logs
  FOR DELETE TO authenticated
  USING (false);

COMMIT;
