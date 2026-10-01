-- SmartDental HMIS - 0013: safe clinic staff membership management

BEGIN;

ALTER TABLE public.clinic_memberships
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.clinics AS clinic
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.clinic_memberships AS membership
      WHERE membership.clinic_id = clinic.id
        AND membership.is_active
        AND membership.role = 'admin'::public.user_role_enum
    )
  ) THEN
    RAISE EXCEPTION 'Every clinic must have an active administrator before staff membership management is enabled';
  END IF;
END;
$$;

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
      AND membership.is_active
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
      AND membership.is_active
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
      AND membership.role IN (
        'admin'::public.user_role_enum,
        'doctor'::public.user_role_enum,
        'receptionist'::public.user_role_enum
      )
      AND membership.is_active
  );
$$;

-- Keep clinic-scoped rows inaccessible to inactive members even where an
-- older permissive policy checks clinic_memberships directly.
CREATE POLICY active_membership_required
ON public.clinics AS RESTRICTIVE
FOR ALL TO authenticated
USING (public.is_clinic_member(id))
WITH CHECK (public.is_clinic_member(id));

CREATE POLICY active_membership_required
ON public.patients AS RESTRICTIVE
FOR ALL TO authenticated
USING (public.is_clinic_member(clinic_id))
WITH CHECK (public.is_clinic_member(clinic_id));

CREATE POLICY active_membership_required
ON public.appointments AS RESTRICTIVE
FOR ALL TO authenticated
USING (public.is_clinic_member(clinic_id))
WITH CHECK (public.is_clinic_member(clinic_id));

CREATE POLICY active_membership_required
ON public.visits AS RESTRICTIVE
FOR ALL TO authenticated
USING (public.is_clinic_member(clinic_id))
WITH CHECK (public.is_clinic_member(clinic_id));

CREATE POLICY active_membership_required
ON public.prescriptions AS RESTRICTIVE
FOR ALL TO authenticated
USING (public.is_clinic_member(clinic_id))
WITH CHECK (public.is_clinic_member(clinic_id));

CREATE POLICY active_membership_required
ON public.investigations AS RESTRICTIVE
FOR ALL TO authenticated
USING (public.is_clinic_member(clinic_id))
WITH CHECK (public.is_clinic_member(clinic_id));

CREATE POLICY active_membership_required
ON public.invoices AS RESTRICTIVE
FOR ALL TO authenticated
USING (public.is_clinic_member(clinic_id))
WITH CHECK (public.is_clinic_member(clinic_id));

CREATE POLICY active_membership_required
ON public.payments AS RESTRICTIVE
FOR ALL TO authenticated
USING (public.is_clinic_member(clinic_id))
WITH CHECK (public.is_clinic_member(clinic_id));

CREATE POLICY active_membership_required
ON public.audit_logs AS RESTRICTIVE
FOR ALL TO authenticated
USING (clinic_id IS NOT NULL AND public.is_clinic_member(clinic_id))
WITH CHECK (clinic_id IS NOT NULL AND public.is_clinic_member(clinic_id));

CREATE POLICY active_membership_required
ON public.dental_chart_entries AS RESTRICTIVE
FOR ALL TO authenticated
USING (public.is_clinic_member(clinic_id))
WITH CHECK (public.is_clinic_member(clinic_id));

-- Membership rows remain readable for self-status and clinic-admin staff lists,
-- but normal authenticated clients cannot mutate or delete them directly.
DROP POLICY IF EXISTS memberships_admin_write ON public.clinic_memberships;
DROP POLICY IF EXISTS memberships_admin_update ON public.clinic_memberships;
DROP POLICY IF EXISTS memberships_admin_delete ON public.clinic_memberships;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.clinic_memberships FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.clinic_memberships TO authenticated;

DROP POLICY IF EXISTS memberships_staff_doctor_read ON public.clinic_memberships;
CREATE POLICY memberships_staff_doctor_read
ON public.clinic_memberships
FOR SELECT
TO authenticated
USING (
  role = 'doctor'::public.user_role_enum
  AND is_active
  AND public.is_clinic_staff(clinic_id)
);

-- Let active clinic staff resolve historical clinician names after a role
-- change; these policies grant profile identity only, not historical access.
DROP POLICY IF EXISTS profiles_historical_clinician_read ON public.profiles;
CREATE POLICY profiles_historical_clinician_read
ON public.profiles
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.appointments AS appointment
    WHERE appointment.doctor_id = profiles.id
      AND public.is_clinic_staff(appointment.clinic_id)
  )
  OR EXISTS (
    SELECT 1
    FROM public.visits AS visit
    WHERE visit.doctor_id = profiles.id
      AND public.is_clinic_staff(visit.clinic_id)
  )
);

CREATE OR REPLACE FUNCTION public.admin_change_clinic_staff_role(
  p_clinic_id uuid,
  p_target_user_id uuid,
  p_new_role public.user_role_enum
)
RETURNS public.clinic_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  target_membership public.clinic_memberships;
  active_admin_count bigint;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_clinic_id IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'Clinic and target staff member are required';
  END IF;
  IF p_target_user_id = current_user_id THEN
    RAISE EXCEPTION 'Administrators cannot change their own staff role';
  END IF;
  IF p_new_role IS NULL OR p_new_role NOT IN (
    'admin'::public.user_role_enum,
    'doctor'::public.user_role_enum,
    'receptionist'::public.user_role_enum
  ) THEN
    RAISE EXCEPTION 'Only admin, doctor, and receptionist roles can be managed';
  END IF;
  IF NOT public.is_clinic_member_as(p_clinic_id, 'admin'::public.user_role_enum) THEN
    RAISE EXCEPTION 'An active clinic administrator is required';
  END IF;

  -- All staff-role changes serialize on the clinic row before counting admins.
  PERFORM 1
  FROM public.clinics AS clinic
  WHERE clinic.id = p_clinic_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Clinic was not found';
  END IF;
  IF NOT public.is_clinic_member_as(p_clinic_id, 'admin'::public.user_role_enum) THEN
    RAISE EXCEPTION 'An active clinic administrator is required';
  END IF;

  SELECT membership.* INTO target_membership
  FROM public.clinic_memberships AS membership
  WHERE membership.clinic_id = p_clinic_id
    AND membership.user_id = p_target_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target membership was not found in this clinic';
  END IF;
  IF target_membership.role = 'patient'::public.user_role_enum THEN
    RAISE EXCEPTION 'Patient memberships are not managed as staff';
  END IF;
  IF target_membership.role = p_new_role THEN
    RAISE EXCEPTION 'Target membership already has that role';
  END IF;

  IF target_membership.is_active
     AND target_membership.role = 'admin'::public.user_role_enum
     AND p_new_role <> 'admin'::public.user_role_enum
  THEN
    SELECT count(*) INTO active_admin_count
    FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = p_clinic_id
      AND membership.is_active
      AND membership.role = 'admin'::public.user_role_enum;
    IF active_admin_count <= 1 THEN
      RAISE EXCEPTION 'A clinic must retain at least one active administrator';
    END IF;
  END IF;

  UPDATE public.clinic_memberships AS membership
  SET role = p_new_role
  WHERE membership.clinic_id = p_clinic_id
    AND membership.user_id = p_target_user_id
  RETURNING membership.* INTO target_membership;

  RETURN target_membership;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_clinic_staff_active(
  p_clinic_id uuid,
  p_target_user_id uuid,
  p_is_active boolean
)
RETURNS public.clinic_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  target_membership public.clinic_memberships;
  active_admin_count bigint;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_clinic_id IS NULL OR p_target_user_id IS NULL OR p_is_active IS NULL THEN
    RAISE EXCEPTION 'Clinic, target staff member, and activation state are required';
  END IF;
  IF p_target_user_id = current_user_id THEN
    RAISE EXCEPTION 'Administrators cannot change their own membership status';
  END IF;
  IF NOT public.is_clinic_member_as(p_clinic_id, 'admin'::public.user_role_enum) THEN
    RAISE EXCEPTION 'An active clinic administrator is required';
  END IF;

  PERFORM 1
  FROM public.clinics AS clinic
  WHERE clinic.id = p_clinic_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Clinic was not found';
  END IF;
  IF NOT public.is_clinic_member_as(p_clinic_id, 'admin'::public.user_role_enum) THEN
    RAISE EXCEPTION 'An active clinic administrator is required';
  END IF;

  SELECT membership.* INTO target_membership
  FROM public.clinic_memberships AS membership
  WHERE membership.clinic_id = p_clinic_id
    AND membership.user_id = p_target_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target membership was not found in this clinic';
  END IF;
  IF target_membership.role = 'patient'::public.user_role_enum THEN
    RAISE EXCEPTION 'Patient memberships are not managed as staff';
  END IF;
  IF target_membership.is_active = p_is_active THEN
    RAISE EXCEPTION 'Target membership already has that activation state';
  END IF;

  IF target_membership.is_active
     AND target_membership.role = 'admin'::public.user_role_enum
     AND NOT p_is_active
  THEN
    SELECT count(*) INTO active_admin_count
    FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = p_clinic_id
      AND membership.is_active
      AND membership.role = 'admin'::public.user_role_enum;
    IF active_admin_count <= 1 THEN
      RAISE EXCEPTION 'A clinic must retain at least one active administrator';
    END IF;
  END IF;

  UPDATE public.clinic_memberships AS membership
  SET is_active = p_is_active
  WHERE membership.clinic_id = p_clinic_id
    AND membership.user_id = p_target_user_id
  RETURNING membership.* INTO target_membership;

  RETURN target_membership;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_change_clinic_staff_role(uuid, uuid, public.user_role_enum) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_change_clinic_staff_role(uuid, uuid, public.user_role_enum) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_set_clinic_staff_active(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_clinic_staff_active(uuid, uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.start_consultation(p_appointment_id uuid)
RETURNS public.visits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  appointment_row public.appointments;
  existing_visit public.visits;
  caller_role public.user_role_enum;
  consultation_visit public.visits;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;

  SELECT appointment.* INTO appointment_row
  FROM public.appointments AS appointment
  WHERE appointment.id = p_appointment_id
  FOR UPDATE;
  IF appointment_row.id IS NULL THEN
    RAISE EXCEPTION 'Appointment was not found';
  END IF;

  SELECT membership.role INTO caller_role
  FROM public.clinic_memberships AS membership
  WHERE membership.clinic_id = appointment_row.clinic_id
    AND membership.user_id = current_user_id
    AND membership.is_active;
  IF caller_role IS NULL OR caller_role NOT IN ('admin', 'doctor') THEN
    RAISE EXCEPTION 'Only an active assigned doctor or clinic administrator can start consultation';
  END IF;
  IF appointment_row.doctor_id IS NULL THEN
    RAISE EXCEPTION 'Appointment has no assigned doctor';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS doctor_membership
    WHERE doctor_membership.clinic_id = appointment_row.clinic_id
      AND doctor_membership.user_id = appointment_row.doctor_id
      AND doctor_membership.role = 'doctor'
      AND doctor_membership.is_active
  ) THEN
    RAISE EXCEPTION 'Appointment doctor is not an active clinic doctor';
  END IF;
  IF caller_role = 'doctor' AND appointment_row.doctor_id <> current_user_id THEN
    RAISE EXCEPTION 'Only the assigned doctor can start this consultation';
  END IF;

  SELECT visit.* INTO existing_visit
  FROM public.visits AS visit
  WHERE visit.appointment_id = appointment_row.id;
  IF appointment_row.status = 'in_progress' AND existing_visit.id IS NOT NULL THEN
    RETURN existing_visit;
  END IF;
  IF appointment_row.status <> 'waiting' THEN
    RAISE EXCEPTION 'Appointment is not waiting for consultation';
  END IF;

  UPDATE public.appointments
  SET status = 'in_progress', updated_at = now()
  WHERE id = appointment_row.id;

  IF existing_visit.id IS NOT NULL THEN
    RETURN existing_visit;
  END IF;

  INSERT INTO public.visits (clinic_id, patient_id, doctor_id, appointment_id, visit_date)
  VALUES (appointment_row.clinic_id, appointment_row.patient_id, appointment_row.doctor_id, appointment_row.id, now())
  RETURNING * INTO consultation_visit;
  RETURN consultation_visit;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_consultation(
  p_visit_id uuid,
  p_chief_complaint text,
  p_hpi text,
  p_examination text,
  p_assessment text,
  p_treatment_plan text,
  p_clinical_notes text,
  p_follow_up_date date,
  p_follow_up_instructions text
)
RETURNS public.visits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  consultation_visit public.visits;
  caller_role public.user_role_enum;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;

  SELECT visit.* INTO consultation_visit
  FROM public.visits AS visit
  JOIN public.appointments AS appointment ON appointment.id = visit.appointment_id
  WHERE visit.id = p_visit_id
    AND appointment.status = 'in_progress'
  FOR UPDATE OF visit;
  IF consultation_visit.id IS NULL THEN
    RAISE EXCEPTION 'Only an in-progress appointment consultation can be saved';
  END IF;

  SELECT membership.role INTO caller_role
  FROM public.clinic_memberships AS membership
  WHERE membership.clinic_id = consultation_visit.clinic_id
    AND membership.user_id = current_user_id
    AND membership.is_active;
  IF caller_role = 'doctor' AND consultation_visit.doctor_id <> current_user_id THEN
    RAISE EXCEPTION 'Only the assigned doctor can edit this consultation';
  END IF;
  IF caller_role IS DISTINCT FROM 'admin' AND caller_role IS DISTINCT FROM 'doctor' THEN
    RAISE EXCEPTION 'Only an active clinic administrator or assigned doctor can edit this consultation';
  END IF;

  UPDATE public.visits
  SET chief_complaint = p_chief_complaint,
      hpi = p_hpi,
      examination = p_examination,
      assessment = p_assessment,
      treatment_plan = p_treatment_plan,
      clinical_notes = p_clinical_notes,
      follow_up_date = p_follow_up_date,
      follow_up_instructions = p_follow_up_instructions,
      updated_at = now()
  WHERE id = p_visit_id
  RETURNING * INTO consultation_visit;
  RETURN consultation_visit;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_invoice(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_visit_id uuid,
  p_total numeric
)
RETURNS public.invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  caller_role public.user_role_enum;
  patient_clinic_id uuid;
  visit_clinic_id uuid;
  visit_patient_id uuid;
  visit_appointment_status public.appointment_status_enum;
  clinic_currency text;
  allocated_number bigint;
  created_invoice public.invoices;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_total IS NULL OR p_total <= 0 THEN
    RAISE EXCEPTION 'Invoice total must be greater than zero';
  END IF;

  SELECT membership.role INTO caller_role
  FROM public.clinic_memberships AS membership
  WHERE membership.clinic_id = p_clinic_id
    AND membership.user_id = current_user_id
    AND membership.is_active;
  IF caller_role IS NULL OR caller_role NOT IN ('admin', 'receptionist') THEN
    RAISE EXCEPTION 'Only an active administrator or receptionist can create invoices';
  END IF;

  SELECT patient.clinic_id INTO patient_clinic_id
  FROM public.patients AS patient
  WHERE patient.id = p_patient_id;
  IF patient_clinic_id IS DISTINCT FROM p_clinic_id THEN
    RAISE EXCEPTION 'Patient does not belong to the invoice clinic';
  END IF;

  SELECT visit.clinic_id, visit.patient_id, appointment.status
    INTO visit_clinic_id, visit_patient_id, visit_appointment_status
  FROM public.visits AS visit
  LEFT JOIN public.appointments AS appointment ON appointment.id = visit.appointment_id
  WHERE visit.id = p_visit_id;
  IF p_visit_id IS NOT NULL THEN
    IF visit_clinic_id IS DISTINCT FROM p_clinic_id OR visit_patient_id IS DISTINCT FROM p_patient_id THEN
      RAISE EXCEPTION 'Visit does not belong to the invoice patient and clinic';
    END IF;
    IF visit_appointment_status IS NOT NULL AND visit_appointment_status <> 'completed' THEN
      RAISE EXCEPTION 'Only completed appointment visits can be billed';
    END IF;
  END IF;

  SELECT clinic.currency INTO clinic_currency
  FROM public.clinics AS clinic
  WHERE clinic.id = p_clinic_id;
  INSERT INTO public.clinic_invoice_sequences (clinic_id, next_invoice_number)
  VALUES (p_clinic_id, 1)
  ON CONFLICT (clinic_id) DO NOTHING;
  UPDATE public.clinic_invoice_sequences
  SET next_invoice_number = next_invoice_number + 1
  WHERE clinic_id = p_clinic_id
  RETURNING next_invoice_number - 1 INTO allocated_number;

  INSERT INTO public.invoices (
    clinic_id, patient_id, visit_id, invoice_number, status, subtotal, discount,
    total, amount_paid, balance, currency
  )
  VALUES (
    p_clinic_id, p_patient_id, p_visit_id,
    'INV-' || lpad(allocated_number::text, 6, '0'), 'draft', p_total, 0,
    p_total, 0, p_total, clinic_currency
  )
  RETURNING * INTO created_invoice;
  RETURN created_invoice;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_method public.payment_method_enum,
  p_reference text DEFAULT NULL
)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  invoice_row public.invoices;
  caller_role public.user_role_enum;
  new_amount_paid numeric;
  created_payment public.payments;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;

  SELECT invoice.* INTO invoice_row
  FROM public.invoices AS invoice
  WHERE invoice.id = p_invoice_id
  FOR UPDATE;
  IF invoice_row.id IS NULL THEN
    RAISE EXCEPTION 'Invoice was not found';
  END IF;

  SELECT membership.role INTO caller_role
  FROM public.clinic_memberships AS membership
  WHERE membership.clinic_id = invoice_row.clinic_id
    AND membership.user_id = current_user_id
    AND membership.is_active;
  IF caller_role IS NULL OR caller_role NOT IN ('admin', 'receptionist') THEN
    RAISE EXCEPTION 'Only an active administrator or receptionist can record payments';
  END IF;
  IF invoice_row.status IN ('cancelled', 'void', 'paid') THEN
    RAISE EXCEPTION 'This invoice cannot accept another payment';
  END IF;
  IF p_amount > invoice_row.balance THEN
    RAISE EXCEPTION 'Payment exceeds the remaining invoice balance';
  END IF;

  new_amount_paid := invoice_row.amount_paid + p_amount;
  INSERT INTO public.payments (clinic_id, invoice_id, patient_id, recorded_by, payment_method, amount, reference)
  VALUES (
    invoice_row.clinic_id, invoice_row.id, invoice_row.patient_id,
    current_user_id, p_payment_method, p_amount, NULLIF(btrim(p_reference), '')
  )
  RETURNING * INTO created_payment;

  UPDATE public.invoices
  SET amount_paid = new_amount_paid,
      balance = invoice_row.total - new_amount_paid,
      status = CASE
        WHEN new_amount_paid = invoice_row.total THEN 'paid'::public.invoice_status_enum
        ELSE 'partially_paid'::public.invoice_status_enum
      END,
      updated_at = now()
  WHERE id = invoice_row.id;
  RETURN created_payment;
END;
$$;

COMMIT;