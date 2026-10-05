-- M13.5A.1: operational queue exits; no deletion or clinical amendments.
BEGIN;

ALTER TABLE public.appointments
  ADD COLUMN queue_exit_reason text,
  ADD COLUMN queue_exited_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  ADD COLUMN queue_exited_at timestamptz;

-- Require the RPC for exit states and metadata, including INSERT bypasses.
-- Existing terminal legacy rows are preserved without fabricated reasons.
CREATE POLICY appointments_queue_exit_insert_guard
ON public.appointments AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (
  status NOT IN ('cancelled', 'no_show')
  AND queue_exit_reason IS NULL AND queue_exited_by IS NULL AND queue_exited_at IS NULL
);
CREATE POLICY appointments_queue_exit_update_guard
ON public.appointments AS RESTRICTIVE FOR UPDATE TO authenticated
USING (status NOT IN ('cancelled', 'no_show'))
WITH CHECK (
  status NOT IN ('cancelled', 'no_show')
  AND queue_exit_reason IS NULL AND queue_exited_by IS NULL AND queue_exited_at IS NULL
);

CREATE FUNCTION public.exit_appointment_queue(
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
