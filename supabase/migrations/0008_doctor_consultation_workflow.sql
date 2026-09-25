-- SmartDental HMIS - 0008: atomic doctor consultation workflow
-- Adds appointment-linked visit uniqueness and caller-validated consultation RPCs.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.visits
    WHERE appointment_id IS NOT NULL
    GROUP BY appointment_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add appointment visit uniqueness: duplicate appointment-linked visits exist';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS visits_appointment_id_unique
  ON public.visits (appointment_id)
  WHERE appointment_id IS NOT NULL;

-- Reception and doctors retain operational appointment updates, but clinical
-- status transitions are available only through the consultation RPCs.
DROP POLICY IF EXISTS appointments_staff_update ON public.appointments;
CREATE POLICY appointments_staff_update
ON public.appointments
FOR UPDATE
TO authenticated
USING (
  public.is_clinic_member_as(clinic_id, 'admin'::public.user_role_enum)
  OR public.is_clinic_member_as(clinic_id, 'receptionist'::public.user_role_enum)
  OR (
    doctor_id = auth.uid()
    AND public.is_clinic_member_as(clinic_id, 'doctor'::public.user_role_enum)
  )
)
WITH CHECK (
  public.is_clinic_member_as(clinic_id, 'admin'::public.user_role_enum)
  OR (
    status NOT IN ('in_progress', 'completed')
    AND public.is_clinic_member_as(clinic_id, 'receptionist'::public.user_role_enum)
  )
  OR (
    status NOT IN ('in_progress', 'completed')
    AND doctor_id = auth.uid()
    AND public.is_clinic_member_as(clinic_id, 'doctor'::public.user_role_enum)
  )
);

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

  SELECT a.* INTO appointment_row
  FROM public.appointments AS a
  WHERE a.id = p_appointment_id
  FOR UPDATE;

  IF appointment_row.id IS NULL THEN
    RAISE EXCEPTION 'Appointment was not found';
  END IF;

  SELECT m.role INTO caller_role
  FROM public.clinic_memberships AS m
  WHERE m.clinic_id = appointment_row.clinic_id
    AND m.user_id = current_user_id;

  IF caller_role IS NULL OR caller_role NOT IN ('admin', 'doctor') THEN
    RAISE EXCEPTION 'Only the assigned doctor or a clinic administrator can start consultation';
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
  ) THEN
    RAISE EXCEPTION 'Appointment doctor is not a valid clinic doctor';
  END IF;

  IF caller_role = 'doctor' AND appointment_row.doctor_id <> current_user_id THEN
    RAISE EXCEPTION 'Only the assigned doctor can start this consultation';
  END IF;

  SELECT v.* INTO existing_visit
  FROM public.visits AS v
  WHERE v.appointment_id = appointment_row.id;

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

  INSERT INTO public.visits (
    clinic_id,
    patient_id,
    doctor_id,
    appointment_id,
    visit_date
  )
  VALUES (
    appointment_row.clinic_id,
    appointment_row.patient_id,
    appointment_row.doctor_id,
    appointment_row.id,
    now()
  )
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
  SELECT v.* INTO consultation_visit
  FROM public.visits AS v
  JOIN public.appointments AS a ON a.id = v.appointment_id
  WHERE v.id = p_visit_id
    AND a.status = 'in_progress'
  FOR UPDATE OF v;

  IF consultation_visit.id IS NULL THEN
    RAISE EXCEPTION 'Only an in-progress appointment consultation can be saved';
  END IF;

  SELECT m.role INTO caller_role
  FROM public.clinic_memberships AS m
  WHERE m.clinic_id = consultation_visit.clinic_id
    AND m.user_id = current_user_id;

  IF caller_role = 'doctor' AND consultation_visit.doctor_id <> current_user_id THEN
    RAISE EXCEPTION 'Only the assigned doctor can edit this consultation';
  END IF;
  IF caller_role IS DISTINCT FROM 'admin' AND caller_role IS DISTINCT FROM 'doctor' THEN
    RAISE EXCEPTION 'Only a clinic administrator or assigned doctor can edit this consultation';
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

CREATE OR REPLACE FUNCTION public.complete_consultation(
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
  completed_visit public.visits;
BEGIN
  completed_visit := public.save_consultation(
    p_visit_id,
    p_chief_complaint,
    p_hpi,
    p_examination,
    p_assessment,
    p_treatment_plan,
    p_clinical_notes,
    p_follow_up_date,
    p_follow_up_instructions
  );

  UPDATE public.appointments
  SET status = 'completed', updated_at = now()
  WHERE id = completed_visit.appointment_id
    AND status = 'in_progress';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Appointment is no longer in progress';
  END IF;

  RETURN completed_visit;
END;
$$;

REVOKE ALL ON FUNCTION public.start_consultation(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_consultation(uuid, text, text, text, text, text, text, date, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_consultation(uuid, text, text, text, text, text, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_consultation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_consultation(uuid, text, text, text, text, text, text, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_consultation(uuid, text, text, text, text, text, text, date, text) TO authenticated;

COMMIT;
