-- SmartDental HMIS — 0002_security_core.sql
-- Security core: non-recursive membership checks, clinic bootstrap,
-- tenant-consistent relationships, and patient-role read restrictions.

BEGIN;

-- ---------------------------------------------------------------------
-- Caller-scoped membership helpers.
-- SECURITY DEFINER is required because policies on clinic_memberships
-- cannot safely read that same table through RLS.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_clinic_member(p_clinic_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = p_clinic_id
      AND membership.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_clinic_member_as(
  p_clinic_id uuid,
  p_role public.user_role_enum
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = p_clinic_id
      AND membership.user_id = auth.uid()
      AND membership.role = p_role
  );
$$;

CREATE OR REPLACE FUNCTION public.is_clinic_staff(p_clinic_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = p_clinic_id
      AND membership.user_id = auth.uid()
      AND membership.role IN ('admin', 'doctor', 'receptionist')
  );
$$;

REVOKE ALL ON FUNCTION public.is_clinic_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_clinic_member_as(uuid, public.user_role_enum) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_clinic_staff(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_clinic_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_clinic_member_as(uuid, public.user_role_enum) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_clinic_staff(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- Atomic first-clinic bootstrap. The role and target user are deliberately
-- not parameters: the caller can only create an admin membership for self.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bootstrap_clinic(p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  new_clinic_id uuid;
  normalized_name text := btrim(p_name);
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;

  IF normalized_name IS NULL OR normalized_name = '' OR char_length(normalized_name) > 200 THEN
    RAISE EXCEPTION 'Clinic name must contain 1 to 200 characters';
  END IF;

  INSERT INTO public.profiles (id)
  VALUES (current_user_id)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clinics (name)
  VALUES (normalized_name)
  RETURNING id INTO new_clinic_id;

  INSERT INTO public.clinic_memberships (user_id, clinic_id, role)
  VALUES (current_user_id, new_clinic_id, 'admin'::public.user_role_enum);

  RETURN new_clinic_id;
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_clinic(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bootstrap_clinic(text) TO authenticated;

-- ---------------------------------------------------------------------
-- Existing-data preflight. No relationship constraint is added if any
-- current row crosses a clinic boundary or references a missing member.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  conflict_count bigint;
  conflict_examples text;
BEGIN
  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT a.id FROM public.appointments a
      LEFT JOIN public.patients p ON p.id = a.patient_id
      WHERE p.id IS NULL OR p.clinic_id <> a.clinic_id
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict appointments.patient_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT a.id FROM public.appointments a
      LEFT JOIN public.clinic_memberships m ON m.user_id = a.doctor_id AND m.clinic_id = a.clinic_id
      WHERE a.doctor_id IS NOT NULL AND m.user_id IS NULL
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict appointments.doctor_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT a.id FROM public.appointments a
      LEFT JOIN public.clinic_memberships m ON m.user_id = a.created_by AND m.clinic_id = a.clinic_id
      WHERE a.created_by IS NOT NULL AND m.user_id IS NULL
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict appointments.created_by: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT v.id FROM public.visits v
      LEFT JOIN public.patients p ON p.id = v.patient_id
      WHERE p.id IS NULL OR p.clinic_id <> v.clinic_id
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict visits.patient_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT v.id FROM public.visits v
      LEFT JOIN public.clinic_memberships m ON m.user_id = v.doctor_id AND m.clinic_id = v.clinic_id
      WHERE m.user_id IS NULL
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict visits.doctor_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT v.id FROM public.visits v
      LEFT JOIN public.appointments a ON a.id = v.appointment_id
      WHERE v.appointment_id IS NOT NULL AND (a.id IS NULL OR a.clinic_id <> v.clinic_id)
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict visits.appointment_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT p.id FROM public.prescriptions p
      LEFT JOIN public.patients patient ON patient.id = p.patient_id
      WHERE patient.id IS NULL OR patient.clinic_id <> p.clinic_id
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict prescriptions.patient_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT p.id FROM public.prescriptions p
      LEFT JOIN public.visits v ON v.id = p.visit_id
      WHERE v.id IS NULL OR v.clinic_id <> p.clinic_id
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict prescriptions.visit_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT p.id FROM public.prescriptions p
      LEFT JOIN public.clinic_memberships m ON m.user_id = p.prescribing_doctor_id AND m.clinic_id = p.clinic_id
      WHERE m.user_id IS NULL
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict prescriptions.prescribing_doctor_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT i.id FROM public.investigations i
      LEFT JOIN public.patients patient ON patient.id = i.patient_id
      WHERE patient.id IS NULL OR patient.clinic_id <> i.clinic_id
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict investigations.patient_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT i.id FROM public.investigations i
      LEFT JOIN public.visits v ON v.id = i.visit_id
      WHERE v.id IS NULL OR v.clinic_id <> i.clinic_id
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict investigations.visit_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT i.id FROM public.investigations i
      LEFT JOIN public.clinic_memberships m ON m.user_id = i.requesting_doctor_id AND m.clinic_id = i.clinic_id
      WHERE m.user_id IS NULL
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict investigations.requesting_doctor_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT i.id FROM public.invoices i
      LEFT JOIN public.patients patient ON patient.id = i.patient_id
      WHERE patient.id IS NULL OR patient.clinic_id <> i.clinic_id
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict invoices.patient_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT i.id FROM public.invoices i
      LEFT JOIN public.visits v ON v.id = i.visit_id
      WHERE i.visit_id IS NOT NULL AND (v.id IS NULL OR v.clinic_id <> i.clinic_id)
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict invoices.visit_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT p.id FROM public.payments p
      LEFT JOIN public.invoices i ON i.id = p.invoice_id
      WHERE i.id IS NULL OR i.clinic_id <> p.clinic_id
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict payments.invoice_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT p.id FROM public.payments p
      LEFT JOIN public.patients patient ON patient.id = p.patient_id
      WHERE patient.id IS NULL OR patient.clinic_id <> p.clinic_id
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict payments.patient_id: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;

  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO conflict_count, conflict_examples
    FROM (
      SELECT p.id FROM public.payments p
      LEFT JOIN public.clinic_memberships m ON m.user_id = p.recorded_by AND m.clinic_id = p.clinic_id
      WHERE p.recorded_by IS NOT NULL AND m.user_id IS NULL
      LIMIT 20
    ) conflicts;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Tenant conflict payments.recorded_by: count=%, example_ids=%', conflict_count, conflict_examples;
  END IF;
END;
$$;

-- Every referenced tenant row gets a unique composite key for the FK.
CREATE UNIQUE INDEX IF NOT EXISTS patients_clinic_id_id_key ON public.patients (clinic_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS appointments_clinic_id_id_key ON public.appointments (clinic_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS visits_clinic_id_id_key ON public.visits (clinic_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_clinic_id_id_key ON public.invoices (clinic_id, id);

-- Tenant-consistent business relationships.
ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_patient_same_clinic_fk
  FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients (clinic_id, id) ON DELETE RESTRICT;
ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_doctor_same_clinic_fk
  FOREIGN KEY (clinic_id, doctor_id) REFERENCES public.clinic_memberships (clinic_id, user_id) ON DELETE RESTRICT;
ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_creator_same_clinic_fk
  FOREIGN KEY (clinic_id, created_by) REFERENCES public.clinic_memberships (clinic_id, user_id) ON DELETE RESTRICT;

ALTER TABLE public.visits
  ADD CONSTRAINT visits_patient_same_clinic_fk
  FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients (clinic_id, id) ON DELETE RESTRICT;
ALTER TABLE public.visits
  ADD CONSTRAINT visits_doctor_same_clinic_fk
  FOREIGN KEY (clinic_id, doctor_id) REFERENCES public.clinic_memberships (clinic_id, user_id) ON DELETE RESTRICT;
ALTER TABLE public.visits
  ADD CONSTRAINT visits_appointment_same_clinic_fk
  FOREIGN KEY (clinic_id, appointment_id) REFERENCES public.appointments (clinic_id, id) ON DELETE RESTRICT;

ALTER TABLE public.prescriptions
  ADD CONSTRAINT prescriptions_patient_same_clinic_fk
  FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients (clinic_id, id) ON DELETE RESTRICT;
ALTER TABLE public.prescriptions
  ADD CONSTRAINT prescriptions_visit_same_clinic_fk
  FOREIGN KEY (clinic_id, visit_id) REFERENCES public.visits (clinic_id, id) ON DELETE RESTRICT;
ALTER TABLE public.prescriptions
  ADD CONSTRAINT prescriptions_doctor_same_clinic_fk
  FOREIGN KEY (clinic_id, prescribing_doctor_id) REFERENCES public.clinic_memberships (clinic_id, user_id) ON DELETE RESTRICT;

ALTER TABLE public.investigations
  ADD CONSTRAINT investigations_patient_same_clinic_fk
  FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients (clinic_id, id) ON DELETE RESTRICT;
ALTER TABLE public.investigations
  ADD CONSTRAINT investigations_visit_same_clinic_fk
  FOREIGN KEY (clinic_id, visit_id) REFERENCES public.visits (clinic_id, id) ON DELETE RESTRICT;
ALTER TABLE public.investigations
  ADD CONSTRAINT investigations_doctor_same_clinic_fk
  FOREIGN KEY (clinic_id, requesting_doctor_id) REFERENCES public.clinic_memberships (clinic_id, user_id) ON DELETE RESTRICT;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_patient_same_clinic_fk
  FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients (clinic_id, id) ON DELETE RESTRICT;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_visit_same_clinic_fk
  FOREIGN KEY (clinic_id, visit_id) REFERENCES public.visits (clinic_id, id) ON DELETE RESTRICT;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_invoice_same_clinic_fk
  FOREIGN KEY (clinic_id, invoice_id) REFERENCES public.invoices (clinic_id, id) ON DELETE RESTRICT;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_patient_same_clinic_fk
  FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients (clinic_id, id) ON DELETE RESTRICT;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_recorder_same_clinic_fk
  FOREIGN KEY (clinic_id, recorded_by) REFERENCES public.clinic_memberships (clinic_id, user_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------
-- Remove membership-table recursion and restrict patient reads to staff.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS memberships_self_read ON public.clinic_memberships;
CREATE POLICY memberships_self_read ON public.clinic_memberships
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_clinic_member_as(clinic_memberships.clinic_id, 'admin'::public.user_role_enum)
  );

DROP POLICY IF EXISTS memberships_admin_write ON public.clinic_memberships;
CREATE POLICY memberships_admin_write ON public.clinic_memberships
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_clinic_member_as(clinic_memberships.clinic_id, 'admin'::public.user_role_enum)
  );

DROP POLICY IF EXISTS memberships_admin_update ON public.clinic_memberships;
CREATE POLICY memberships_admin_update ON public.clinic_memberships
  FOR UPDATE TO authenticated
  USING (public.is_clinic_member_as(clinic_memberships.clinic_id, 'admin'::public.user_role_enum))
  WITH CHECK (public.is_clinic_member_as(clinic_memberships.clinic_id, 'admin'::public.user_role_enum));

DROP POLICY IF EXISTS memberships_admin_delete ON public.clinic_memberships;
CREATE POLICY memberships_admin_delete ON public.clinic_memberships
  FOR DELETE TO authenticated
  USING (public.is_clinic_member_as(clinic_memberships.clinic_id, 'admin'::public.user_role_enum));

DROP POLICY IF EXISTS patients_select ON public.patients;
CREATE POLICY patients_select ON public.patients
  FOR SELECT TO authenticated
  USING (public.is_clinic_staff(patients.clinic_id));

DROP POLICY IF EXISTS appointments_select ON public.appointments;
CREATE POLICY appointments_select ON public.appointments
  FOR SELECT TO authenticated
  USING (public.is_clinic_staff(appointments.clinic_id));

DROP POLICY IF EXISTS visits_select ON public.visits;
CREATE POLICY visits_select ON public.visits
  FOR SELECT TO authenticated
  USING (public.is_clinic_staff(visits.clinic_id));

DROP POLICY IF EXISTS prescriptions_select ON public.prescriptions;
CREATE POLICY prescriptions_select ON public.prescriptions
  FOR SELECT TO authenticated
  USING (public.is_clinic_staff(prescriptions.clinic_id));

DROP POLICY IF EXISTS investigations_select ON public.investigations;
CREATE POLICY investigations_select ON public.investigations
  FOR SELECT TO authenticated
  USING (public.is_clinic_staff(investigations.clinic_id));

DROP POLICY IF EXISTS invoices_select ON public.invoices;
CREATE POLICY invoices_select ON public.invoices
  FOR SELECT TO authenticated
  USING (public.is_clinic_staff(invoices.clinic_id));

DROP POLICY IF EXISTS payments_select ON public.payments;
CREATE POLICY payments_select ON public.payments
  FOR SELECT TO authenticated
  USING (public.is_clinic_staff(payments.clinic_id));

COMMIT;
