-- M13.5D.1: close clinical creation bypasses without rewriting clinical history.
BEGIN;
-- Freeze writes before preflight/baseline; abort rather than repair conflicts.
LOCK TABLE public.clinics, public.appointments, public.visits,
  public.prescriptions, public.investigations, public.dental_chart_entries IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.visits v JOIN public.appointments a ON a.id = v.appointment_id
    WHERE v.clinic_id <> a.clinic_id OR v.patient_id <> a.patient_id OR v.doctor_id IS DISTINCT FROM a.doctor_id)
    OR EXISTS (SELECT 1 FROM public.prescriptions r JOIN public.visits v ON v.id = r.visit_id
      WHERE r.clinic_id <> v.clinic_id OR r.patient_id <> v.patient_id OR r.prescribing_doctor_id <> v.doctor_id)
    OR EXISTS (SELECT 1 FROM public.investigations r JOIN public.visits v ON v.id = r.visit_id
      WHERE r.clinic_id <> v.clinic_id OR r.patient_id <> v.patient_id OR r.requesting_doctor_id <> v.doctor_id) THEN
    RAISE EXCEPTION 'Legacy clinical relationship inconsistencies require review before 0021';
  END IF;
END;
$$;

-- Legacy recording actors remain unknown; original timestamps/clinicians stay intact.
ALTER TABLE public.visits ADD COLUMN recorded_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.prescriptions ADD COLUMN recorded_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.investigations ADD COLUMN recorded_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT;
CREATE POLICY visits_standalone_insert_only ON public.visits AS RESTRICTIVE
  FOR INSERT TO authenticated WITH CHECK (appointment_id IS NULL AND doctor_id = auth.uid());
DROP POLICY IF EXISTS appointments_admin_delete ON public.appointments;
REVOKE DELETE ON public.appointments FROM PUBLIC, anon, authenticated;
CREATE POLICY appointments_no_direct_delete ON public.appointments AS RESTRICTIVE
  FOR DELETE TO authenticated USING (false);

CREATE TABLE public.standalone_visit_lifecycle (
  clinic_id uuid NOT NULL,
  visit_id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('saved', 'finalized')),
  legacy_baseline boolean NOT NULL DEFAULT false,
  finalized_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  finalized_at timestamptz,
  FOREIGN KEY (clinic_id, visit_id) REFERENCES public.visits(clinic_id, id) ON DELETE RESTRICT,
  CHECK ((state = 'saved' AND NOT legacy_baseline AND finalized_by IS NULL AND finalized_at IS NULL)
    OR (state = 'finalized' AND legacy_baseline AND finalized_by IS NULL AND finalized_at IS NULL)
    OR (state = 'finalized' AND NOT legacy_baseline AND finalized_by IS NOT NULL AND finalized_at IS NOT NULL))
);
ALTER TABLE public.standalone_visit_lifecycle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.standalone_visit_lifecycle FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.standalone_visit_lifecycle TO authenticated;
CREATE POLICY standalone_lifecycle_staff_read ON public.standalone_visit_lifecycle
  FOR SELECT TO authenticated USING (public.is_clinic_staff(clinic_id));
-- Baseline before triggers: no fabricated historical actor/time or finalization event.
INSERT INTO public.standalone_visit_lifecycle (clinic_id, visit_id, state, legacy_baseline)
SELECT clinic_id, id, 'finalized', true FROM public.visits WHERE appointment_id IS NULL;

CREATE FUNCTION public.guard_clinical_creation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  actor uuid := auth.uid();
  v public.visits;
  a public.appointments;
  actor_role public.user_role_enum;
  clinician_role public.user_role_enum;
  lifecycle_state text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authenticated clinical recording is required'; END IF;
  IF TG_TABLE_NAME = 'dental_chart_entries' THEN
    IF NEW.supersedes_entry_id IS NOT NULL THEN
      -- RPC validates/locks correction context. Never upgrade its appointment
      -- SHARE lock here. Direct correction INSERT remains restrictively RLS-denied.
      IF NEW.recorded_by IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Recording actor mismatch'; END IF;
      NEW.created_at := clock_timestamp();
      RETURN NEW;
    END IF;
  END IF;
  PERFORM 1 FROM public.clinics c WHERE c.id = NEW.clinic_id FOR KEY SHARE;
  IF TG_TABLE_NAME = 'visits' THEN
    IF NEW.appointment_id IS NULL THEN
      IF NEW.doctor_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Standalone author must match actor'; END IF;
    ELSE
      SELECT * INTO a FROM public.appointments WHERE id = NEW.appointment_id FOR UPDATE;
      IF NOT FOUND OR a.status <> 'in_progress' OR a.clinic_id <> NEW.clinic_id
        OR a.patient_id <> NEW.patient_id OR a.doctor_id IS DISTINCT FROM NEW.doctor_id THEN
        RAISE EXCEPTION 'Invalid consultation creation context';
      END IF;
    END IF;
    v := NEW;
  ELSE
    SELECT * INTO v FROM public.visits WHERE id = NEW.visit_id;
    IF NOT FOUND OR v.clinic_id <> NEW.clinic_id THEN RAISE EXCEPTION 'Invalid visit context'; END IF;
    IF v.appointment_id IS NOT NULL THEN
      SELECT * INTO a FROM public.appointments WHERE id = v.appointment_id FOR UPDATE;
      IF NOT FOUND OR a.status <> 'in_progress' OR a.clinic_id <> v.clinic_id
        OR a.patient_id <> v.patient_id OR a.doctor_id IS DISTINCT FROM v.doctor_id THEN
        RAISE EXCEPTION 'Ordinary recording requires an in-progress consultation';
      END IF;
    END IF;
    SELECT * INTO v FROM public.visits WHERE id = NEW.visit_id FOR SHARE;
    IF v.appointment_id IS NULL THEN
      SELECT state INTO lifecycle_state FROM public.standalone_visit_lifecycle
      WHERE visit_id = v.id AND clinic_id = v.clinic_id FOR SHARE;
      IF lifecycle_state IS DISTINCT FROM 'saved' THEN
        RAISE EXCEPTION 'Standalone visit is finalized or lifecycle is unavailable';
      END IF;
    END IF;
  END IF;
  PERFORM 1 FROM public.clinic_memberships m
  WHERE m.clinic_id = v.clinic_id AND m.user_id IN (actor, v.doctor_id)
  ORDER BY m.user_id FOR SHARE;
  SELECT role INTO actor_role FROM public.clinic_memberships
  WHERE clinic_id = v.clinic_id AND user_id = actor AND is_active;
  SELECT role INTO clinician_role FROM public.clinic_memberships
  WHERE clinic_id = v.clinic_id AND user_id = v.doctor_id AND is_active;
  IF actor_role IS NULL OR actor_role NOT IN ('admin', 'doctor')
    OR (actor_role = 'doctor' AND v.doctor_id <> actor) OR clinician_role IS NULL
    OR (clinician_role <> 'doctor' AND NOT (v.appointment_id IS NULL AND v.doctor_id = actor AND clinician_role = 'admin'))
    OR NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.id = v.patient_id AND p.clinic_id = v.clinic_id) THEN
    RAISE EXCEPTION 'Active clinical author and matching patient context are required';
  END IF;
  IF TG_TABLE_NAME = 'prescriptions' THEN
    IF NEW.patient_id <> v.patient_id OR NEW.prescribing_doctor_id <> v.doctor_id THEN
      RAISE EXCEPTION 'Prescription patient or clinician mismatch';
    END IF;
  ELSIF TG_TABLE_NAME = 'investigations' THEN
    IF NEW.patient_id <> v.patient_id OR NEW.requesting_doctor_id <> v.doctor_id THEN
      RAISE EXCEPTION 'Investigation patient or clinician mismatch';
    END IF;
  END IF;
  IF NEW.recorded_by IS NOT NULL AND NEW.recorded_by <> actor THEN RAISE EXCEPTION 'Recording actor mismatch'; END IF;
  NEW.recorded_by := actor;
  NEW.created_at := clock_timestamp();
  IF TG_TABLE_NAME IN ('visits', 'investigations') THEN NEW.updated_at := NEW.created_at; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_clinical_creation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER visits_guard_creation BEFORE INSERT ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinical_creation();
CREATE TRIGGER prescriptions_guard_creation BEFORE INSERT ON public.prescriptions
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinical_creation();
CREATE TRIGGER investigations_guard_creation BEFORE INSERT ON public.investigations
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinical_creation();
CREATE TRIGGER dental_chart_guard_creation BEFORE INSERT ON public.dental_chart_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinical_creation();

CREATE FUNCTION public.initialize_standalone_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.appointment_id IS NULL THEN
    INSERT INTO public.standalone_visit_lifecycle (clinic_id, visit_id, state) VALUES (NEW.clinic_id, NEW.id, 'saved');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.initialize_standalone_lifecycle() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER visits_initialize_standalone AFTER INSERT ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.initialize_standalone_lifecycle();

CREATE FUNCTION public.protect_recording_attribution()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by THEN
    RAISE EXCEPTION 'Original recording attribution is immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_recording_attribution() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER visits_protect_recording BEFORE UPDATE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.protect_recording_attribution();
CREATE TRIGGER prescriptions_protect_recording BEFORE UPDATE ON public.prescriptions
  FOR EACH ROW EXECUTE FUNCTION public.protect_recording_attribution();
CREATE TRIGGER investigations_protect_recording BEFORE UPDATE ON public.investigations
  FOR EACH ROW EXECUTE FUNCTION public.protect_recording_attribution();

CREATE FUNCTION public.protect_standalone_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, auth
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'saved' OR NEW.legacy_baseline OR NOT EXISTS
      (SELECT 1 FROM public.visits v WHERE v.id = NEW.visit_id AND v.clinic_id = NEW.clinic_id AND v.appointment_id IS NULL) THEN
      RAISE EXCEPTION 'Invalid new standalone lifecycle';
    END IF;
  ELSE
    IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id OR NEW.visit_id IS DISTINCT FROM OLD.visit_id
      OR NEW.legacy_baseline IS DISTINCT FROM OLD.legacy_baseline OR OLD.state <> 'saved' OR NEW.state <> 'finalized'
      OR NEW.finalized_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Standalone lifecycle cannot be reassigned or reopened';
    END IF;
    NEW.finalized_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_standalone_lifecycle() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER standalone_lifecycle_guard BEFORE INSERT OR UPDATE ON public.standalone_visit_lifecycle
  FOR EACH ROW EXECUTE FUNCTION public.protect_standalone_lifecycle();

CREATE FUNCTION public.finalize_standalone_visit(p_visit_id uuid)
RETURNS public.standalone_visit_lifecycle LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE actor uuid := auth.uid(); v public.visits; result public.standalone_visit_lifecycle; actor_role public.user_role_enum;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication is required'; END IF;
  SELECT * INTO v FROM public.visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Standalone visit is unavailable'; END IF;
  PERFORM 1 FROM public.clinics c WHERE c.id = v.clinic_id FOR KEY SHARE;
  SELECT * INTO v FROM public.visits WHERE id = p_visit_id FOR UPDATE;
  IF v.appointment_id IS NOT NULL THEN RAISE EXCEPTION 'Only standalone visits can be finalized here'; END IF;
  SELECT role INTO actor_role FROM public.clinic_memberships
  WHERE clinic_id = v.clinic_id AND user_id = actor AND is_active FOR SHARE;
  IF actor_role IS NULL OR actor_role NOT IN ('admin', 'doctor') OR (actor_role = 'doctor' AND v.doctor_id <> actor) THEN
    RAISE EXCEPTION 'Active administrator or visit author is required';
  END IF;
  SELECT * INTO result FROM public.standalone_visit_lifecycle WHERE visit_id = v.id AND clinic_id = v.clinic_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Standalone lifecycle is unavailable'; END IF;
  IF result.state = 'finalized' THEN RETURN result; END IF;
  UPDATE public.standalone_visit_lifecycle SET state = 'finalized', finalized_by = actor, finalized_at = clock_timestamp()
  WHERE visit_id = v.id RETURNING * INTO result;
  INSERT INTO public.audit_logs (clinic_id, actor_user_id, table_name, record_id, action, metadata)
  VALUES (v.clinic_id, actor, 'standalone_visit_lifecycle', v.id, 'finalized',
    jsonb_build_object('visit_id', v.id, 'patient_id', v.patient_id));
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_standalone_visit(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_standalone_visit(uuid) TO authenticated;

CREATE FUNCTION public.require_finalized_standalone_billing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v public.visits; lifecycle_state text;
BEGIN
  IF NEW.visit_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v FROM public.visits WHERE id = NEW.visit_id;
  IF v.appointment_id IS NULL THEN
    SELECT * INTO v FROM public.visits WHERE id = NEW.visit_id FOR SHARE;
    SELECT state INTO lifecycle_state FROM public.standalone_visit_lifecycle
    WHERE visit_id = v.id AND clinic_id = NEW.clinic_id FOR SHARE;
    IF lifecycle_state IS DISTINCT FROM 'finalized' THEN RAISE EXCEPTION 'Finalize standalone visit before billing'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.require_finalized_standalone_billing() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER invoices_require_finalized_standalone BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.require_finalized_standalone_billing();

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

  PERFORM 1 FROM public.clinics c WHERE c.id =
    (SELECT a.clinic_id FROM public.appointments a WHERE a.id = p_appointment_id) FOR KEY SHARE;
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

  PERFORM 1 FROM public.clinic_memberships m
  WHERE m.clinic_id = appointment_row.clinic_id AND m.user_id IN (current_user_id, appointment_row.doctor_id)
  ORDER BY m.user_id FOR SHARE;
  IF NOT public.is_clinic_member_as(appointment_row.clinic_id, caller_role)
     OR NOT EXISTS (SELECT 1 FROM public.clinic_memberships m WHERE m.clinic_id = appointment_row.clinic_id
                    AND m.user_id = appointment_row.doctor_id AND m.role = 'doctor' AND m.is_active)
     OR NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.id = appointment_row.patient_id
                    AND p.clinic_id = appointment_row.clinic_id) THEN
    RAISE EXCEPTION 'Active consultation authorization and matching patient are required';
  END IF;
  SELECT visit.* INTO existing_visit
  FROM public.visits AS visit
  WHERE visit.appointment_id = appointment_row.id;
  IF existing_visit.id IS NOT NULL AND (existing_visit.clinic_id <> appointment_row.clinic_id
     OR existing_visit.patient_id <> appointment_row.patient_id OR existing_visit.doctor_id <> appointment_row.doctor_id) THEN
    RAISE EXCEPTION 'Existing consultation relationships are inconsistent';
  END IF;
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

  PERFORM 1 FROM public.clinics c WHERE c.id =
    (SELECT a.clinic_id FROM public.appointments a WHERE a.id = linked_appointment_id) FOR KEY SHARE;
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

CREATE OR REPLACE FUNCTION public.correct_dental_chart_entry(
  p_entry_id uuid,
  p_surfaces text[],
  p_finding text,
  p_procedure_text text,
  p_notes text,
  p_reason text
)
RETURNS public.dental_chart_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  actor_id uuid := auth.uid();
  target public.dental_chart_entries;
  source_visit public.visits;
  linked_appointment_id uuid;
  source_appointment public.appointments;
  created_entry public.dental_chart_entries;
  normalized_reason text := regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  normalized_finding text := NULLIF(btrim(p_finding), '');
  normalized_procedure text := NULLIF(btrim(p_procedure_text), '');
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF normalized_reason IS NULL OR char_length(normalized_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Enter a correction reason of 1 to 500 characters';
  END IF;
  IF normalized_finding IS NULL AND normalized_procedure IS NULL THEN
    RAISE EXCEPTION 'Enter a corrected finding or procedure';
  END IF;
  IF char_length(normalized_finding) > 500 OR char_length(normalized_procedure) > 500
     OR char_length(p_notes) > 2000 THEN
    RAISE EXCEPTION 'Corrected information exceeds the field length limit';
  END IF;

  SELECT e.* INTO target FROM public.dental_chart_entries AS e WHERE e.id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dental entry is unavailable';
  END IF;
  PERFORM 1 FROM public.clinics c WHERE c.id = target.clinic_id FOR KEY SHARE;
  -- Hold authorization stable against role changes/deactivation.
  PERFORM 1 FROM public.clinic_memberships AS m
  WHERE m.clinic_id = target.clinic_id AND m.user_id = actor_id
    AND m.role = 'doctor' AND m.is_active FOR SHARE;
  IF NOT FOUND OR target.recorded_by <> actor_id THEN
    RAISE EXCEPTION 'Only the active assigned doctor who recorded this entry can correct it';
  END IF;

  -- Discovery only: locking the visit here would invert the existing
  -- appointment-before-visit consultation lock order.
  SELECT v.appointment_id INTO linked_appointment_id FROM public.visits AS v
  WHERE v.id = target.visit_id AND v.clinic_id = target.clinic_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The visit context is unavailable';
  END IF;
  -- Match consultation appointment-before-visit locking. Completed records
  -- remain completed and unchanged; the amendment is a new dental row only.
  -- 0011 and the normal patient-history form also support standalone visits.
  -- Those retain the same assigned-doctor/patient checks below.
  IF linked_appointment_id IS NOT NULL THEN
    SELECT a.* INTO source_appointment FROM public.appointments AS a
    WHERE a.id = linked_appointment_id FOR SHARE;
    IF NOT FOUND OR source_appointment.clinic_id <> target.clinic_id
       OR source_appointment.doctor_id IS DISTINCT FROM actor_id
       OR source_appointment.status NOT IN ('in_progress', 'completed') THEN
      RAISE EXCEPTION 'The consultation context is not valid for correction';
    END IF;
  END IF;
  SELECT v.* INTO source_visit FROM public.visits AS v
  WHERE v.id = target.visit_id AND v.clinic_id = target.clinic_id FOR SHARE;
  IF NOT FOUND OR source_visit.doctor_id <> actor_id
     OR source_visit.appointment_id IS DISTINCT FROM linked_appointment_id
     OR NOT EXISTS (SELECT 1 FROM public.patients AS p
                    WHERE p.id = source_visit.patient_id AND p.clinic_id = target.clinic_id) THEN
    RAISE EXCEPTION 'The visit patient and clinician context is not valid for correction';
  END IF;
  IF linked_appointment_id IS NOT NULL
     AND source_appointment.patient_id IS DISTINCT FROM source_visit.patient_id THEN
    RAISE EXCEPTION 'The appointment patient does not match the visit';
  END IF;

  SELECT e.* INTO target FROM public.dental_chart_entries AS e
  WHERE e.id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dental entry is unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.dental_chart_entries AS e WHERE e.supersedes_entry_id = target.id) THEN
    RAISE EXCEPTION 'This entry has already been corrected. Refresh and correct the current entry';
  END IF;

  INSERT INTO public.dental_chart_entries (
    clinic_id, visit_id, tooth_number, surfaces, entry_type, finding,
    procedure_text, notes, recorded_by, supersedes_entry_id, correction_reason
  ) VALUES (
    target.clinic_id, target.visit_id, target.tooth_number, COALESCE(p_surfaces, '{}'::text[]),
    CASE WHEN normalized_finding IS NOT NULL AND normalized_procedure IS NOT NULL THEN 'finding_and_procedure'
         WHEN normalized_finding IS NOT NULL THEN 'finding' ELSE 'procedure' END,
    normalized_finding, normalized_procedure, NULLIF(btrim(p_notes), ''),
    actor_id, target.id, normalized_reason
  ) RETURNING * INTO created_entry;
  RETURN created_entry;
END;
$$;

REVOKE ALL ON FUNCTION public.correct_dental_chart_entry(uuid, text[], text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.correct_dental_chart_entry(uuid, text[], text, text, text, text)
  TO authenticated;


REVOKE ALL ON FUNCTION public.start_consultation(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_consultation(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.save_consultation(uuid, text, text, text, text, text, text, date, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_consultation(uuid, text, text, text, text, text, text, date, text) TO authenticated;
-- Queue-exit business behavior/signature unchanged; clinic-first locking only.
CREATE OR REPLACE FUNCTION public.exit_appointment_queue(
  p_appointment_id uuid,
  p_status public.appointment_status_enum,
  p_reason text
)
RETURNS public.appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  actor_id uuid := auth.uid();
  appointment_row public.appointments;
  caller_role public.user_role_enum;
  normalized_reason text := regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('cancelled', 'no_show') THEN
    RAISE EXCEPTION 'Choose cancellation or no-show / left';
  END IF;
  IF normalized_reason IS NULL OR normalized_reason = '' OR char_length(normalized_reason) > 500 THEN
    RAISE EXCEPTION 'Enter an operational reason of 1 to 500 characters';
  END IF;

  -- Clinic first: staff mutations and audit FK locks must not invert this order.
  PERFORM 1 FROM public.clinics c WHERE c.id =
    (SELECT a.clinic_id FROM public.appointments a WHERE a.id = p_appointment_id) FOR KEY SHARE;
  -- Serialize against start/save/complete consultation using the same row lock.
  SELECT a.* INTO appointment_row FROM public.appointments AS a
  WHERE a.id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Appointment is unavailable';
  END IF;
  SELECT m.role INTO caller_role FROM public.clinic_memberships AS m
  WHERE m.clinic_id = appointment_row.clinic_id AND m.user_id = actor_id
    AND m.is_active FOR SHARE;
  IF caller_role IS NULL OR caller_role NOT IN ('admin', 'receptionist', 'doctor')
     OR (caller_role = 'doctor' AND appointment_row.doctor_id IS DISTINCT FROM actor_id) THEN
    RAISE EXCEPTION 'An active administrator, receptionist or assigned doctor is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.patients AS p
                 WHERE p.id = appointment_row.patient_id AND p.clinic_id = appointment_row.clinic_id) THEN
    RAISE EXCEPTION 'Appointment patient does not belong to this clinic';
  END IF;
  IF appointment_row.status = 'in_progress' THEN
    RAISE EXCEPTION 'Consultation has started. This appointment cannot leave through the queue action';
  END IF;
  IF appointment_row.status NOT IN ('scheduled', 'confirmed', 'arrived', 'waiting') THEN
    RAISE EXCEPTION 'Only pre-consultation appointments can be cancelled or marked no-show / left';
  END IF;
  IF EXISTS (SELECT 1 FROM public.visits AS v WHERE v.appointment_id = appointment_row.id) THEN
    RAISE EXCEPTION 'This appointment has a clinical visit and cannot leave through the queue action';
  END IF;

  UPDATE public.appointments
  SET status = p_status, queue_exit_reason = normalized_reason,
      queue_exited_by = actor_id, queue_exited_at = now(), updated_at = now()
  WHERE id = appointment_row.id RETURNING * INTO appointment_row;
  -- Existing 0016 AFTER UPDATE audit captures auth.uid(), clinic, appointment,
  -- status_changed, old_status and new_status atomically; no reason text is copied.
  RETURN appointment_row;
END;
$$;

REVOKE ALL ON FUNCTION public.exit_appointment_queue(uuid, public.appointment_status_enum, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exit_appointment_queue(uuid, public.appointment_status_enum, text)
  TO authenticated;


COMMIT;
