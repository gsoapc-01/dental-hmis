-- M13.5C: operational care initiation, not clinical visit creation.
-- Existing appointments and clinical records are not rewritten.
BEGIN;

CREATE TABLE public.encounter_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'booked')),
  CONSTRAINT encounter_contexts_identity_unique UNIQUE (clinic_id, patient_id, id),
  CONSTRAINT encounter_contexts_patient_fk FOREIGN KEY (clinic_id, patient_id)
    REFERENCES public.patients (clinic_id, id) ON DELETE RESTRICT,
  CONSTRAINT encounter_contexts_creator_fk FOREIGN KEY (clinic_id, created_by)
    REFERENCES public.clinic_memberships (clinic_id, user_id) ON DELETE RESTRICT
);
-- Only one unfinished booking per patient; multiple scheduled encounters remain possible.
CREATE UNIQUE INDEX encounter_contexts_one_pending_patient
  ON public.encounter_contexts (clinic_id, patient_id) WHERE state = 'pending';

ALTER TABLE public.encounter_contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.encounter_contexts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.encounter_contexts TO authenticated;
CREATE POLICY encounter_contexts_staff_read ON public.encounter_contexts
  FOR SELECT TO authenticated USING (public.is_clinic_staff(clinic_id));

-- Nullable only for already-existing appointments. No backfill or historical relinking.
ALTER TABLE public.appointments
  ADD COLUMN encounter_context_id uuid,
  ADD CONSTRAINT appointments_encounter_context_fk
    FOREIGN KEY (clinic_id, patient_id, encounter_context_id)
    REFERENCES public.encounter_contexts (clinic_id, patient_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX appointments_one_per_encounter_context
  ON public.appointments (encounter_context_id) WHERE encounter_context_id IS NOT NULL;

CREATE FUNCTION public.protect_encounter_booking_context()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'encounter_contexts' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Encounter identity and creation details cannot be reassigned';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state
       AND NOT (OLD.state = 'pending' AND NEW.state = 'booked') THEN
      RAISE EXCEPTION 'A booked encounter cannot be reopened';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.encounter_context_id IS NULL THEN
      RAISE EXCEPTION 'Start New Visit before booking an appointment';
    END IF;
    IF NEW.status <> 'scheduled' OR NEW.queue_exit_reason IS NOT NULL
       OR NEW.queue_exited_by IS NOT NULL OR NEW.queue_exited_at IS NOT NULL THEN
      RAISE EXCEPTION 'New appointments must begin as scheduled without queue-exit data';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.encounter_contexts AS e
                   WHERE e.id = NEW.encounter_context_id AND e.clinic_id = NEW.clinic_id
                     AND e.patient_id = NEW.patient_id AND e.state = 'pending') THEN
      RAISE EXCEPTION 'A matching pending encounter is required';
    END IF;
  ELSE
    IF NEW.encounter_context_id IS DISTINCT FROM OLD.encounter_context_id
       OR (OLD.encounter_context_id IS NOT NULL
           AND (NEW.clinic_id IS DISTINCT FROM OLD.clinic_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id)) THEN
      RAISE EXCEPTION 'A booked appointment cannot be reassigned to another encounter or patient';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_encounter_booking_context() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER encounter_contexts_protect_identity BEFORE UPDATE ON public.encounter_contexts
  FOR EACH ROW EXECUTE FUNCTION public.protect_encounter_booking_context();
CREATE TRIGGER appointments_require_encounter BEFORE INSERT OR UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.protect_encounter_booking_context();

-- Booking ownership and initial status are validated by the RPC, not client INSERT fields.
REVOKE INSERT ON TABLE public.appointments FROM PUBLIC, anon, authenticated;
CREATE POLICY appointments_no_direct_insert ON public.appointments AS RESTRICTIVE
  FOR INSERT TO authenticated WITH CHECK (false);

CREATE FUNCTION public.start_encounter_context(p_clinic_id uuid, p_patient_id uuid)
RETURNS public.encounter_contexts LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  actor_id uuid := auth.uid();
  result public.encounter_contexts;
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'Authentication is required'; END IF;
  -- Staff-management RPCs lock clinic before membership. Acquire the FK parent
  -- lock first, so a later INSERT cannot invert that order during deactivation.
  PERFORM 1 FROM public.clinics AS c WHERE c.id = p_clinic_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clinic is unavailable'; END IF;
  PERFORM 1 FROM public.clinic_memberships AS m
  WHERE m.clinic_id = p_clinic_id AND m.user_id = actor_id AND m.is_active
    AND m.role IN ('admin', 'receptionist', 'doctor') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active clinic scheduling access is required'; END IF;
  -- Start and booking use clinic -> membership -> patient -> context lock order.
  -- Lock the existing patient even when no pending context exists: concurrent
  -- callers wait here before checking/inserting, rather than racing on the index.
  PERFORM 1 FROM public.patients AS p WHERE p.id = p_patient_id AND p.clinic_id = p_clinic_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patient is unavailable in this clinic'; END IF;
  SELECT e.* INTO result FROM public.encounter_contexts AS e
  WHERE e.clinic_id = p_clinic_id AND e.patient_id = p_patient_id AND e.state = 'pending' FOR UPDATE;
  IF FOUND THEN RETURN result; END IF;
  INSERT INTO public.encounter_contexts (clinic_id, patient_id, created_by)
  VALUES (p_clinic_id, p_patient_id, actor_id) RETURNING * INTO result;
  RETURN result;
END;
$$;

CREATE FUNCTION public.book_encounter_appointment(
  p_encounter_id uuid, p_patient_id uuid, p_doctor_id uuid,
  p_appointment_date date, p_start_time time, p_end_time time,
  p_service text, p_notes text
)
RETURNS public.appointments LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  actor_id uuid := auth.uid();
  encounter public.encounter_contexts;
  result public.appointments;
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'Authentication is required'; END IF;
  SELECT e.* INTO encounter FROM public.encounter_contexts AS e WHERE e.id = p_encounter_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Encounter is unavailable'; END IF;
  PERFORM 1 FROM public.clinics AS c WHERE c.id = encounter.clinic_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clinic is unavailable'; END IF;
  PERFORM 1 FROM public.clinic_memberships AS m
  WHERE m.clinic_id = encounter.clinic_id AND m.user_id = actor_id AND m.is_active
    AND m.role IN ('admin', 'receptionist', 'doctor') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active clinic scheduling access is required'; END IF;
  IF p_patient_id IS DISTINCT FROM encounter.patient_id THEN
    RAISE EXCEPTION 'Encounter does not belong to the selected patient';
  END IF;
  PERFORM 1 FROM public.patients AS p
  WHERE p.id = encounter.patient_id AND p.clinic_id = encounter.clinic_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patient is unavailable in this clinic'; END IF;
  SELECT e.* INTO encounter FROM public.encounter_contexts AS e WHERE e.id = p_encounter_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Encounter is unavailable'; END IF;
  SELECT a.* INTO result FROM public.appointments AS a WHERE a.encounter_context_id = encounter.id;
  -- Replay returns the actual existing booking, including cancellation/completion;
  -- it never changes scheduling fields, restarts care or creates another appointment.
  IF FOUND THEN RETURN result; END IF;
  IF encounter.state <> 'pending' THEN RAISE EXCEPTION 'Encounter is already booked; refresh its appointment'; END IF;
  IF p_appointment_date IS NULL OR p_start_time IS NULL OR p_end_time IS NULL
     OR p_end_time <= p_start_time OR p_doctor_id IS NULL THEN
    RAISE EXCEPTION 'Choose a doctor, appointment date and valid start/end times';
  END IF;
  PERFORM 1 FROM public.clinic_memberships AS m
  WHERE m.clinic_id = encounter.clinic_id AND m.user_id = p_doctor_id
    AND m.role = 'doctor' AND m.is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active doctor in this clinic'; END IF;
  INSERT INTO public.appointments (
    clinic_id, patient_id, doctor_id, created_by, encounter_context_id,
    appointment_date, start_time, end_time, service, notes, status
  ) VALUES (
    encounter.clinic_id, encounter.patient_id, p_doctor_id, actor_id, encounter.id,
    p_appointment_date, p_start_time, p_end_time, NULLIF(btrim(p_service), ''), NULLIF(btrim(p_notes), ''), 'scheduled'
  ) RETURNING * INTO result;
  UPDATE public.encounter_contexts SET state = 'booked' WHERE id = encounter.id;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.start_encounter_context(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.book_encounter_appointment(uuid, uuid, uuid, date, time, time, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_encounter_context(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.book_encounter_appointment(uuid, uuid, uuid, date, time, time, text, text) TO authenticated;

-- Existing appointment audit remains unchanged. Add narrow operational context events.
CREATE FUNCTION public.capture_encounter_context_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  appointment_id uuid;
  actor_id uuid := auth.uid();
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required for encounter audit attribution';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.created_by IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'Encounter creator must match the authenticated actor';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NULL; END IF;
    SELECT a.id INTO appointment_id FROM public.appointments AS a WHERE a.encounter_context_id = NEW.id;
  END IF;
  INSERT INTO public.audit_logs (clinic_id, actor_user_id, table_name, record_id, action, metadata)
  VALUES (NEW.clinic_id, actor_id, 'encounter_contexts', NEW.id,
          CASE WHEN TG_OP = 'INSERT' THEN 'initiated' ELSE 'booked' END,
          jsonb_strip_nulls(jsonb_build_object('state', NEW.state, 'appointment_id', appointment_id)));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.capture_encounter_context_audit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER encounter_contexts_audit AFTER INSERT OR UPDATE ON public.encounter_contexts
  FOR EACH ROW EXECUTE FUNCTION public.capture_encounter_context_audit();

COMMIT;
