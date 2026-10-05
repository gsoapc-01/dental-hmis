-- M13.5A: saved clinical records are writable only through validated workflows.
-- No historical rows are rewritten and no amendment functionality is introduced.
BEGIN;

DROP POLICY IF EXISTS visits_update ON public.visits;
DROP POLICY IF EXISTS visits_delete ON public.visits;
DROP POLICY IF EXISTS prescriptions_update ON public.prescriptions;
DROP POLICY IF EXISTS investigations_update ON public.investigations;

-- Restrictive policies also defend against another permissive policy being added.
CREATE POLICY visits_no_direct_update ON public.visits AS RESTRICTIVE
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY visits_no_direct_delete ON public.visits AS RESTRICTIVE
  FOR DELETE TO authenticated USING (false);
CREATE POLICY prescriptions_no_direct_update ON public.prescriptions AS RESTRICTIVE
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY investigations_no_direct_update ON public.investigations AS RESTRICTIVE
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);

-- Preserve SELECT/INSERT, including the existing clinical creation policies.
-- Prescription/investigation DELETE policies already deny deletion.
REVOKE UPDATE, DELETE ON TABLE public.visits, public.prescriptions,
  public.investigations FROM PUBLIC, anon, authenticated;

-- Direct check-in/waiting updates retain the existing role/assignment policy.
-- Clinical status writes belong to the owner-executed consultation RPCs.
CREATE POLICY appointments_no_direct_clinical_status
ON public.appointments AS RESTRICTIVE
FOR UPDATE TO authenticated
USING (status NOT IN ('in_progress', 'completed'))
WITH CHECK (status NOT IN ('in_progress', 'completed'));

CREATE FUNCTION public.protect_saved_clinical_relationships()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'visits' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id
       OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id THEN
      RAISE EXCEPTION 'Saved visit identity and relationships cannot be changed';
    END IF;
  ELSIF TG_TABLE_NAME = 'appointments' THEN
    IF OLD.status = 'completed' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Completed consultations cannot be reopened';
    END IF;
    IF OLD.status = 'in_progress'
       AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.status <> 'completed' THEN
      RAISE EXCEPTION 'An in-progress consultation can only transition to completed';
    END IF;
    -- A linked consultation must keep the same patient, doctor and tenant.
    -- SELECT access to visits is already granted to clinic staff; owner RPCs
    -- also see linked rows. This function does not elevate caller privileges.
    IF (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
        OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
        OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id)
       AND EXISTS (SELECT 1 FROM public.visits WHERE appointment_id = OLD.id) THEN
      RAISE EXCEPTION 'Appointment relationships cannot change after a visit is linked';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported clinical relationship trigger table';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_saved_clinical_relationships()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER visits_protect_saved_relationships
  BEFORE UPDATE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.protect_saved_clinical_relationships();
CREATE TRIGGER appointments_protect_consultation_history
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.protect_saved_clinical_relationships();

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
  linked_appointment_id uuid;
  appointment_row public.appointments;
  consultation_visit public.visits;
  caller_role public.user_role_enum;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;

  SELECT visit.appointment_id INTO linked_appointment_id
  FROM public.visits AS visit WHERE visit.id = p_visit_id;
  IF linked_appointment_id IS NULL THEN
    RAISE EXCEPTION 'Only an in-progress appointment consultation can be saved';
  END IF;

  -- Match start_consultation's appointment-first lock order. complete_consultation
  -- calls this function in the same transaction, retaining this lock until its
  -- status update commits. A waiting save rechecks the locked row's current state.
  SELECT appointment.* INTO appointment_row
  FROM public.appointments AS appointment
  WHERE appointment.id = linked_appointment_id
  FOR UPDATE;
  IF NOT FOUND OR appointment_row.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Only an in-progress appointment consultation can be saved';
  END IF;

  SELECT visit.* INTO consultation_visit
  FROM public.visits AS visit WHERE visit.id = p_visit_id
  FOR UPDATE;
  IF NOT FOUND
     OR consultation_visit.appointment_id IS DISTINCT FROM appointment_row.id
     OR consultation_visit.clinic_id IS DISTINCT FROM appointment_row.clinic_id
     OR consultation_visit.patient_id IS DISTINCT FROM appointment_row.patient_id
     OR consultation_visit.doctor_id IS DISTINCT FROM appointment_row.doctor_id
     OR NOT EXISTS (
       SELECT 1 FROM public.patients AS patient
       WHERE patient.id = consultation_visit.patient_id
         AND patient.clinic_id = consultation_visit.clinic_id
     ) THEN
    RAISE EXCEPTION 'Consultation relationships do not match the appointment';
  END IF;

  SELECT membership.role INTO caller_role
  FROM public.clinic_memberships AS membership
  WHERE membership.clinic_id = consultation_visit.clinic_id
    AND membership.user_id = current_user_id
    AND membership.is_active
  FOR SHARE;
  -- Retain the existing active-admin draft workflow, never historical rewriting.
  IF caller_role IS DISTINCT FROM 'admin' AND caller_role IS DISTINCT FROM 'doctor' THEN
    RAISE EXCEPTION 'Only an active clinic administrator or assigned doctor can edit this consultation';
  END IF;
  IF caller_role = 'doctor' AND consultation_visit.doctor_id <> current_user_id THEN
    RAISE EXCEPTION 'Only the assigned doctor can edit this consultation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = consultation_visit.clinic_id
      AND membership.user_id = consultation_visit.doctor_id
      AND membership.role = 'doctor' AND membership.is_active
  ) THEN
    RAISE EXCEPTION 'Consultation doctor must be an active clinic doctor';
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

REVOKE ALL ON FUNCTION public.save_consultation(uuid, text, text, text, text, text, text, date, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_consultation(uuid, text, text, text, text, text, text, date, text)
  TO authenticated;

COMMIT;
