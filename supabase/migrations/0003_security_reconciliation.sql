-- ============================================================
-- SmartDental HMIS
-- Migration 0003: Security Core
--
-- Purpose:
--   1. Remove clinic_memberships RLS recursion.
--   2. Harden SECURITY DEFINER helper permissions.
--   3. Preserve the existing secure bootstrap function.
--   4. Restrict broad tenant-wide access to staff roles.
--   5. Keep existing tenant-consistency constraints untouched.
--
-- IMPORTANT:
--   - Does NOT modify 0001_initial_schema.sql.
--   - Does NOT recreate existing same-clinic foreign keys.
--   - Does NOT disable RLS.
--   - Does NOT reset or delete data.
-- ============================================================

BEGIN;


-- ============================================================
-- 1. SECURITY-DEFINER HELPER FUNCTIONS
-- ============================================================

-- These functions already exist in the database.
-- Re-create their known-good definitions so this migration
-- establishes the intended security behavior explicitly.

CREATE OR REPLACE FUNCTION public.is_clinic_member(
  p_clinic_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = p_clinic_id
      AND membership.user_id = auth.uid()
  );
$function$;


CREATE OR REPLACE FUNCTION public.is_clinic_member_as(
  p_clinic_id uuid,
  p_role public.user_role_enum
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = p_clinic_id
      AND membership.user_id = auth.uid()
      AND membership.role = p_role
  );
$function$;


CREATE OR REPLACE FUNCTION public.is_clinic_staff(
  p_clinic_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = p_clinic_id
      AND membership.user_id = auth.uid()
      AND membership.role IN (
        'admin',
        'doctor',
        'receptionist'
      )
  );
$function$;


-- Secure clinic bootstrap.
--
-- This function intentionally performs the initial:
--   profile -> clinic -> admin membership
-- sequence under SECURITY DEFINER so the initial admin
-- does not encounter the normal membership/clinic RLS
-- bootstrap deadlock.

CREATE OR REPLACE FUNCTION public.bootstrap_clinic(
  p_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
DECLARE
  current_user_id uuid := auth.uid();
  new_clinic_id uuid;
  normalized_name text := btrim(p_name);
BEGIN

  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;

  IF normalized_name IS NULL
     OR normalized_name = ''
     OR char_length(normalized_name) > 200
  THEN
    RAISE EXCEPTION 'Clinic name must contain 1 to 200 characters';
  END IF;

  -- Ensure the authenticated user has a profile.
  INSERT INTO public.profiles (id)
  VALUES (current_user_id)
  ON CONFLICT (id) DO NOTHING;

  -- Create the clinic.
  INSERT INTO public.clinics (name)
  VALUES (normalized_name)
  RETURNING id INTO new_clinic_id;

  -- Make the creator the clinic administrator.
  INSERT INTO public.clinic_memberships (
    user_id,
    clinic_id,
    role
  )
  VALUES (
    current_user_id,
    new_clinic_id,
    'admin'::public.user_role_enum
  );

  RETURN new_clinic_id;
END;
$function$;


-- ============================================================
-- 2. FUNCTION EXECUTION PERMISSIONS
-- ============================================================

-- SECURITY DEFINER functions must not remain executable by
-- arbitrary roles.

REVOKE EXECUTE
ON FUNCTION public.is_clinic_member(uuid)
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE
ON FUNCTION public.is_clinic_member_as(uuid, public.user_role_enum)
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE
ON FUNCTION public.is_clinic_staff(uuid)
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE
ON FUNCTION public.bootstrap_clinic(text)
FROM PUBLIC, anon, authenticated;


-- Authenticated users need these helpers because they are
-- used by authenticated RLS policies.

GRANT EXECUTE
ON FUNCTION public.is_clinic_member(uuid)
TO authenticated;

GRANT EXECUTE
ON FUNCTION public.is_clinic_member_as(uuid, public.user_role_enum)
TO authenticated;

GRANT EXECUTE
ON FUNCTION public.is_clinic_staff(uuid)
TO authenticated;

GRANT EXECUTE
ON FUNCTION public.bootstrap_clinic(text)
TO authenticated;


-- ============================================================
-- 3. CLINIC MEMBERSHIP POLICIES
-- ============================================================
--
-- IMPORTANT:
-- The old policies queried clinic_memberships directly from
-- clinic_memberships policies, causing recursive RLS behavior.
--
-- The replacement policies call SECURITY DEFINER helpers.
-- ============================================================

DROP POLICY IF EXISTS memberships_self_read
ON public.clinic_memberships;

DROP POLICY IF EXISTS memberships_admin_write
ON public.clinic_memberships;

DROP POLICY IF EXISTS memberships_admin_update
ON public.clinic_memberships;

DROP POLICY IF EXISTS memberships_admin_delete
ON public.clinic_memberships;


-- A user may always read their own memberships.
-- An administrator may read memberships belonging to a clinic
-- where that administrator is a member.

CREATE POLICY memberships_self_read
ON public.clinic_memberships
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.is_clinic_member_as(
    clinic_id,
    'admin'::public.user_role_enum
  )
);


-- Only clinic administrators may create memberships.

CREATE POLICY memberships_admin_write
ON public.clinic_memberships
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_clinic_member_as(
    clinic_id,
    'admin'::public.user_role_enum
  )
);


-- Only clinic administrators may update memberships.

CREATE POLICY memberships_admin_update
ON public.clinic_memberships
FOR UPDATE
TO authenticated
USING (
  public.is_clinic_member_as(
    clinic_id,
    'admin'::public.user_role_enum
  )
)
WITH CHECK (
  public.is_clinic_member_as(
    clinic_id,
    'admin'::public.user_role_enum
  )
);


-- Only clinic administrators may remove memberships.

CREATE POLICY memberships_admin_delete
ON public.clinic_memberships
FOR DELETE
TO authenticated
USING (
  public.is_clinic_member_as(
    clinic_id,
    'admin'::public.user_role_enum
  )
);


-- ============================================================
-- 4. CLINIC ACCESS
-- ============================================================

-- Direct clinic INSERT is intentionally removed.
--
-- New clinics must be created through bootstrap_clinic(),
-- which atomically creates the clinic and its first admin.

DROP POLICY IF EXISTS clinics_admin_write
ON public.clinics;


-- Existing clinic SELECT was membership-wide.
-- Restrict broad tenant access to staff until the patient
-- portal identity model is implemented.

DROP POLICY IF EXISTS clinics_select
ON public.clinics;

CREATE POLICY clinics_select
ON public.clinics
FOR SELECT
TO authenticated
USING (
  public.is_clinic_staff(id)
);


-- Existing admin update policy is replaced with the
-- SECURITY DEFINER helper.

DROP POLICY IF EXISTS clinics_admin_update
ON public.clinics;

CREATE POLICY clinics_admin_update
ON public.clinics
FOR UPDATE
TO authenticated
USING (
  public.is_clinic_member_as(
    id,
    'admin'::public.user_role_enum
  )
)
WITH CHECK (
  public.is_clinic_member_as(
    id,
    'admin'::public.user_role_enum
  )
);


-- ============================================================
-- 5. APPOINTMENTS
-- ============================================================

DROP POLICY IF EXISTS appointments_select
ON public.appointments;

CREATE POLICY appointments_select
ON public.appointments
FOR SELECT
TO authenticated
USING (
  public.is_clinic_staff(clinic_id)
);


-- ============================================================
-- 6. PATIENTS
-- ============================================================
--
-- Patient role is deliberately NOT given broad tenant-wide
-- access.
--
-- A future patient portal will require an explicit mapping
-- between auth.users and the patient's patient record.
-- Until that exists, patients must not inherit clinic-wide
-- patient access merely because they belong to the clinic.

DROP POLICY IF EXISTS patients_select
ON public.patients;

CREATE POLICY patients_select
ON public.patients
FOR SELECT
TO authenticated
USING (
  public.is_clinic_staff(clinic_id)
);


-- ============================================================
-- 7. VISITS
-- ============================================================

DROP POLICY IF EXISTS visits_select
ON public.visits;

CREATE POLICY visits_select
ON public.visits
FOR SELECT
TO authenticated
USING (
  public.is_clinic_staff(clinic_id)
);


-- ============================================================
-- 8. PRESCRIPTIONS
-- ============================================================

DROP POLICY IF EXISTS prescriptions_select
ON public.prescriptions;

CREATE POLICY prescriptions_select
ON public.prescriptions
FOR SELECT
TO authenticated
USING (
  public.is_clinic_staff(clinic_id)
);


-- ============================================================
-- 9. INVESTIGATIONS
-- ============================================================

DROP POLICY IF EXISTS investigations_select
ON public.investigations;

CREATE POLICY investigations_select
ON public.investigations
FOR SELECT
TO authenticated
USING (
  public.is_clinic_staff(clinic_id)
);


-- ============================================================
-- 10. INVOICES
-- ============================================================

DROP POLICY IF EXISTS invoices_select
ON public.invoices;

CREATE POLICY invoices_select
ON public.invoices
FOR SELECT
TO authenticated
USING (
  public.is_clinic_staff(clinic_id)
);


-- ============================================================
-- 11. PAYMENTS
-- ============================================================

DROP POLICY IF EXISTS payments_select
ON public.payments;

CREATE POLICY payments_select
ON public.payments
FOR SELECT
TO authenticated
USING (
  public.is_clinic_staff(clinic_id)
);


-- ============================================================
-- 12. AUDIT LOGS
-- ============================================================
--
-- Audit logs are already restricted to administrators for
-- SELECT. Replace the policy so it uses the helper rather
-- than directly querying clinic_memberships.
-- ============================================================

DROP POLICY IF EXISTS audit_logs_admin_read
ON public.audit_logs;

CREATE POLICY audit_logs_admin_read
ON public.audit_logs
FOR SELECT
TO authenticated
USING (
  public.is_clinic_member_as(
    clinic_id,
    'admin'::public.user_role_enum
  )
);


-- ============================================================
-- 13. PROFILES
-- ============================================================
--
-- profiles_admin_read previously used nested direct
-- clinic_memberships queries. Replace those with the
-- SECURITY DEFINER helper.
-- ============================================================

DROP POLICY IF EXISTS profiles_admin_read
ON public.profiles;

CREATE POLICY profiles_admin_read
ON public.profiles
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.user_id = profiles.id
      AND public.is_clinic_member_as(
        membership.clinic_id,
        'admin'::public.user_role_enum
      )
  )
);


-- Keep profiles_self_rw unchanged.
-- A user may manage their own profile through the existing
-- self policy.


-- ============================================================
-- 14. SECURITY COMMENTS
-- ============================================================

COMMENT ON FUNCTION public.is_clinic_member(uuid)
IS 'SECURITY DEFINER helper used by RLS to determine whether the current authenticated user belongs to a clinic without recursively evaluating clinic_memberships RLS.';

COMMENT ON FUNCTION public.is_clinic_member_as(uuid, public.user_role_enum)
IS 'SECURITY DEFINER helper used by RLS to determine whether the current authenticated user has a specific role in a clinic without recursively evaluating clinic_memberships RLS.';

COMMENT ON FUNCTION public.is_clinic_staff(uuid)
IS 'SECURITY DEFINER helper used by RLS to determine whether the current authenticated user is an admin, doctor, or receptionist in a clinic.';

COMMENT ON FUNCTION public.bootstrap_clinic(text)
IS 'Secure authenticated clinic bootstrap that creates a clinic and its initial admin membership atomically.';


-- ============================================================
-- 15. FINAL TRANSACTION
-- ============================================================

COMMIT;