-- M13.5B: append-only, same-tooth odontogram corrections.
BEGIN;

ALTER TABLE public.dental_chart_entries
  ADD COLUMN supersedes_entry_id uuid,
  ADD COLUMN correction_reason text,
  ADD CONSTRAINT dental_chart_entries_correction_shape CHECK (
    (supersedes_entry_id IS NULL AND correction_reason IS NULL)
    OR (
      supersedes_entry_id IS NOT NULL AND correction_reason IS NOT NULL
      AND supersedes_entry_id <> id
      AND char_length(correction_reason) BETWEEN 1 AND 500
      AND correction_reason = regexp_replace(correction_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g')
    )
  ),
  ADD CONSTRAINT dental_chart_entries_context_id_unique
    UNIQUE (clinic_id, visit_id, tooth_number, id),
  ADD CONSTRAINT dental_chart_entries_supersedes_same_context_fk
    FOREIGN KEY (clinic_id, visit_id, tooth_number, supersedes_entry_id)
    REFERENCES public.dental_chart_entries (clinic_id, visit_id, tooth_number, id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX dental_chart_entries_one_successor
  ON public.dental_chart_entries (supersedes_entry_id)
  WHERE supersedes_entry_id IS NOT NULL;

-- Keep the original creation policy: normal recording remains unchanged.
-- A correction can only enter through the caller-validated owner RPC below.
CREATE POLICY dental_chart_entries_original_insert_only
ON public.dental_chart_entries AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (supersedes_entry_id IS NULL AND correction_reason IS NULL);
REVOKE UPDATE, DELETE ON TABLE public.dental_chart_entries FROM PUBLIC, anon, authenticated;
CREATE POLICY dental_chart_entries_no_direct_update
ON public.dental_chart_entries AS RESTRICTIVE FOR UPDATE TO authenticated
USING (false) WITH CHECK (false);
CREATE POLICY dental_chart_entries_no_direct_delete
ON public.dental_chart_entries AS RESTRICTIVE FOR DELETE TO authenticated
USING (false);

CREATE FUNCTION public.correct_dental_chart_entry(
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

-- Audit capture replacement below preserves all existing event branches and
-- changes only the dental insert branch. Reason/narrative text is never copied.

CREATE OR REPLACE FUNCTION public.capture_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  event_clinic_id uuid;
  event_record_id uuid;
  event_actor_id uuid := auth.uid();
  event_action text;
  event_metadata jsonb := '{}'::jsonb;
  changed_fields text[];
  invoice_currency text;
BEGIN
  IF TG_TABLE_NAME = 'clinics' THEN
    event_clinic_id := NEW.id;
    event_record_id := NEW.id;
    IF TG_OP = 'INSERT' THEN
      event_action := 'created';
    ELSIF OLD.currency IS DISTINCT FROM NEW.currency THEN
      event_action := 'currency_changed';
      event_metadata := jsonb_build_object(
        'old_currency', OLD.currency,
        'new_currency', NEW.currency
      );
    ELSE
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'patients' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    IF TG_OP = 'INSERT' THEN
      event_action := 'created';
    ELSE
      SELECT COALESCE(array_agg(fields.key ORDER BY fields.key), ARRAY[]::text[])
      INTO changed_fields
      FROM jsonb_each(to_jsonb(NEW)) AS fields(key, value)
      WHERE fields.key NOT IN ('created_at', 'updated_at')
        AND (to_jsonb(OLD) -> fields.key) IS DISTINCT FROM fields.value;
      IF cardinality(changed_fields) = 0 THEN
        RETURN NULL;
      END IF;
      event_action := 'updated';
      event_metadata := jsonb_build_object('changed_fields', to_jsonb(changed_fields));
    END IF;
  ELSIF TG_TABLE_NAME = 'appointments' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    IF TG_OP = 'INSERT' THEN
      event_action := 'created';
      event_metadata := jsonb_build_object('new_status', NEW.status);
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      event_action := 'status_changed';
      event_metadata := jsonb_build_object(
        'old_status', OLD.status,
        'new_status', NEW.status
      );
    ELSE
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'visits' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    IF TG_OP = 'INSERT' THEN
      event_action := 'created';
    ELSE
      SELECT COALESCE(array_agg(fields.key ORDER BY fields.key), ARRAY[]::text[])
      INTO changed_fields
      FROM jsonb_each(to_jsonb(NEW)) AS fields(key, value)
      WHERE fields.key NOT IN ('created_at', 'updated_at')
        AND (to_jsonb(OLD) -> fields.key) IS DISTINCT FROM fields.value;
      IF cardinality(changed_fields) = 0 THEN
        RETURN NULL;
      END IF;
      event_action := 'consultation_updated';
      event_metadata := jsonb_build_object('changed_fields', to_jsonb(changed_fields));
    END IF;
  ELSIF TG_TABLE_NAME = 'prescriptions' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    event_action := 'created';
  ELSIF TG_TABLE_NAME = 'investigations' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    event_action := 'created';
  ELSIF TG_TABLE_NAME = 'dental_chart_entries' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    event_action := CASE WHEN NEW.supersedes_entry_id IS NULL THEN 'created' ELSE 'corrected' END;
    event_metadata := jsonb_build_object(
      'tooth_number', NEW.tooth_number,
      'entry_type', NEW.entry_type,
      'surfaces', to_jsonb(NEW.surfaces),
      'visit_id', NEW.visit_id,
      'supersedes_entry_id', NEW.supersedes_entry_id
    );
  ELSIF TG_TABLE_NAME = 'invoices' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    event_action := 'created';
    event_metadata := jsonb_build_object('amount', NEW.total, 'currency', NEW.currency);
  ELSIF TG_TABLE_NAME = 'payments' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    event_action := 'recorded';
    SELECT invoice.currency
    INTO invoice_currency
    FROM public.invoices AS invoice
    WHERE invoice.id = NEW.invoice_id;
    event_metadata := jsonb_build_object(
      'amount', NEW.amount,
      'currency', invoice_currency,
      'payment_method', NEW.payment_method
    );
  ELSIF TG_TABLE_NAME = 'clinic_memberships' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.user_id;
    IF OLD.role IS DISTINCT FROM NEW.role
       AND OLD.is_active IS DISTINCT FROM NEW.is_active THEN
      event_action := 'staff_updated';
      event_metadata := jsonb_build_object(
        'old_role', OLD.role,
        'new_role', NEW.role,
        'old_is_active', OLD.is_active,
        'new_is_active', NEW.is_active
      );
    ELSIF OLD.role IS DISTINCT FROM NEW.role THEN
      event_action := 'role_changed';
      event_metadata := jsonb_build_object('old_role', OLD.role, 'new_role', NEW.role);
    ELSIF OLD.is_active IS DISTINCT FROM NEW.is_active THEN
      event_action := CASE WHEN NEW.is_active THEN 'activated' ELSE 'deactivated' END;
      event_metadata := jsonb_build_object(
        'old_is_active', OLD.is_active,
        'new_is_active', NEW.is_active
      );
    ELSE
      RETURN NULL;
    END IF;
    event_actor_id := auth.uid();
  ELSE
    RAISE EXCEPTION 'Unsupported audit trigger table: %', TG_TABLE_NAME;
  END IF;

  INSERT INTO public.audit_logs (
    clinic_id,
    actor_user_id,
    table_name,
    record_id,
    action,
    metadata
  )
  VALUES (
    event_clinic_id,
    event_actor_id,
    TG_TABLE_NAME,
    event_record_id,
    event_action,
    event_metadata
  );

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_audit_event() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
