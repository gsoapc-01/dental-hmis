-- M13.5D.2: immutable resulting-state patient clinical background snapshots.
BEGIN;
-- Block writes while establishing a complete, unmodified legacy baseline.
LOCK TABLE public.clinics, public.patients IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.patients p LEFT JOIN public.clinics c ON c.id = p.clinic_id
             WHERE c.id IS NULL) THEN
    RAISE EXCEPTION 'Patient tenant inconsistencies require review before 0022';
  END IF;
END;
$$;

ALTER TABLE public.patients ADD COLUMN clinical_profile_version integer NOT NULL DEFAULT 1
  CHECK (clinical_profile_version > 0);
CREATE TABLE public.patient_clinical_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  allergies text,
  current_medications text,
  medical_history text,
  previous_surgery text,
  family_history text,
  dental_history text,
  relevant_habits text,
  pregnancy_status text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  actor_display_name text,
  origin text NOT NULL CHECK (origin IN ('legacy_baseline', 'created', 'updated')),
  changed_fields text[] NOT NULL DEFAULT '{}',
  UNIQUE (clinic_id, patient_id, version_number),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients(clinic_id, id) ON DELETE RESTRICT,
  CHECK ((origin = 'legacy_baseline' AND version_number = 1 AND recorded_by IS NULL AND actor_display_name IS NULL)
      OR (origin = 'created' AND version_number = 1 AND recorded_by IS NOT NULL)
      OR (origin = 'updated' AND version_number > 1 AND recorded_by IS NOT NULL AND cardinality(changed_fields) > 0)),
  CHECK (array_position(changed_fields, NULL) IS NULL AND changed_fields <@ ARRAY[
    'allergies', 'current_medications', 'medical_history', 'previous_surgery',
    'family_history', 'dental_history', 'relevant_habits', 'pregnancy_status']::text[])
);
ALTER TABLE public.patient_clinical_profile_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.patient_clinical_profile_versions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.patient_clinical_profile_versions TO authenticated;
CREATE POLICY clinical_profile_history_staff_read ON public.patient_clinical_profile_versions
  FOR SELECT TO authenticated USING (public.is_clinic_staff(clinic_id));

-- No invented recording actor, original recording date, normalization or audit events.
INSERT INTO public.patient_clinical_profile_versions (
  clinic_id, patient_id, version_number, allergies, current_medications, medical_history,
  previous_surgery, family_history, dental_history, relevant_habits, pregnancy_status, origin
)
SELECT clinic_id, id, 1, allergies, current_medications, medical_history,
  previous_surgery, family_history, dental_history, relevant_habits, pregnancy_status, 'legacy_baseline'
FROM public.patients;

-- A table UPDATE grant overrides column restrictions: remove both table and
-- existing column grants before restoring ordinary demographic/contact editing.
REVOKE UPDATE ON public.patients FROM PUBLIC, anon, authenticated;
DO $$
DECLARE patient_columns text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO patient_columns
  FROM pg_attribute WHERE attrelid = 'public.patients'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE 'REVOKE UPDATE (' || patient_columns || ') ON public.patients FROM PUBLIC, anon, authenticated';
END;
$$;
GRANT UPDATE (first_name, middle_name, last_name, date_of_birth, approximate_age_years,
  gender, national_id, phone, whatsapp, email, address, emergency_contact_name,
  emergency_contact_relationship, emergency_contact_phone, nationality, occupation,
  marital_status, preferred_language) ON public.patients TO authenticated;

CREATE FUNCTION public.prepare_patient_clinical_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth
AS $$
DECLARE clinical_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Ignore client-supplied initial counters; initialization is always version 1.
    NEW.clinical_profile_version := 1;
    clinical_changed := true;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
       OR NEW.patient_number IS DISTINCT FROM OLD.patient_number OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Patient identity and registration attribution are immutable';
    END IF;
    IF NEW.clinical_profile_version IS DISTINCT FROM OLD.clinical_profile_version THEN
      RAISE EXCEPTION 'Clinical profile version is server controlled';
    END IF;
    clinical_changed := ROW(NEW.allergies, NEW.current_medications, NEW.medical_history, NEW.previous_surgery,
      NEW.family_history, NEW.dental_history, NEW.relevant_habits, NEW.pregnancy_status) IS DISTINCT FROM
      ROW(OLD.allergies, OLD.current_medications, OLD.medical_history, OLD.previous_surgery,
      OLD.family_history, OLD.dental_history, OLD.relevant_habits, OLD.pregnancy_status);
  END IF;
  IF NOT clinical_changed THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL OR NOT public.is_clinic_staff(NEW.clinic_id) THEN
    RAISE EXCEPTION 'Active same-clinic staff recording is required';
  END IF;
  NEW.allergies := NULLIF(regexp_replace(NEW.allergies, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  NEW.current_medications := NULLIF(regexp_replace(NEW.current_medications, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  NEW.medical_history := NULLIF(regexp_replace(NEW.medical_history, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  NEW.previous_surgery := NULLIF(regexp_replace(NEW.previous_surgery, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  NEW.family_history := NULLIF(regexp_replace(NEW.family_history, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  NEW.dental_history := NULLIF(regexp_replace(NEW.dental_history, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  NEW.relevant_habits := NULLIF(regexp_replace(NEW.relevant_habits, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  NEW.pregnancy_status := NULLIF(regexp_replace(NEW.pregnancy_status, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.allergies, NEW.current_medications, NEW.medical_history, NEW.previous_surgery,
      NEW.family_history, NEW.dental_history, NEW.relevant_habits, NEW.pregnancy_status) IS NOT DISTINCT FROM
      ROW(OLD.allergies, OLD.current_medications, OLD.medical_history, OLD.previous_surgery,
      OLD.family_history, OLD.dental_history, OLD.relevant_habits, OLD.pregnancy_status) THEN RETURN NEW; END IF;
    NEW.clinical_profile_version := OLD.clinical_profile_version + 1;
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.prepare_patient_clinical_profile() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER patients_prepare_clinical_profile BEFORE INSERT OR UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.prepare_patient_clinical_profile();

CREATE FUNCTION public.snapshot_patient_clinical_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth
AS $$
DECLARE actor uuid := auth.uid(); actor_name text; changed text[]; old_profile jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.clinical_profile_version = OLD.clinical_profile_version THEN RETURN NULL; END IF;
    old_profile := to_jsonb(OLD);
  ELSE
    old_profile := '{}'::jsonb;
  END IF;
  IF actor IS NULL OR NOT public.is_clinic_staff(NEW.clinic_id) THEN
    RAISE EXCEPTION 'Active same-clinic staff recording is required';
  END IF;
  SELECT display_name INTO actor_name FROM public.profiles WHERE id = actor;
  SELECT COALESCE(array_agg(field ORDER BY field), '{}'::text[]) INTO changed
  FROM unnest(ARRAY['allergies', 'current_medications', 'medical_history', 'previous_surgery',
    'family_history', 'dental_history', 'relevant_habits', 'pregnancy_status']) AS fields(field)
  WHERE (to_jsonb(NEW) -> field) IS DISTINCT FROM COALESCE(old_profile -> field, 'null'::jsonb);
  INSERT INTO public.patient_clinical_profile_versions (
    clinic_id, patient_id, version_number, allergies, current_medications, medical_history,
    previous_surgery, family_history, dental_history, relevant_habits, pregnancy_status,
    recorded_by, recorded_at, actor_display_name, origin, changed_fields
  ) VALUES (NEW.clinic_id, NEW.id, NEW.clinical_profile_version, NEW.allergies, NEW.current_medications,
    NEW.medical_history, NEW.previous_surgery, NEW.family_history, NEW.dental_history, NEW.relevant_habits,
    NEW.pregnancy_status, actor, clock_timestamp(), actor_name,
    CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END, changed);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.snapshot_patient_clinical_profile() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER patients_snapshot_clinical_profile AFTER INSERT OR UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_patient_clinical_profile();

CREATE FUNCTION public.protect_patient_clinical_history()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Patient clinical profile history is immutable';
END;
$$;
REVOKE ALL ON FUNCTION public.protect_patient_clinical_history() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER clinical_profile_history_immutable BEFORE UPDATE OR DELETE ON public.patient_clinical_profile_versions
  FOR EACH ROW EXECUTE FUNCTION public.protect_patient_clinical_history();
CREATE TRIGGER clinical_profile_history_no_truncate BEFORE TRUNCATE ON public.patient_clinical_profile_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_patient_clinical_history();

CREATE FUNCTION public.update_patient_clinical_profile(
  p_clinic_id uuid, p_patient_id uuid, p_expected_version integer,
  p_allergies text, p_current_medications text, p_medical_history text, p_previous_surgery text,
  p_family_history text, p_dental_history text, p_relevant_habits text, p_pregnancy_status text
)
RETURNS public.patients LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth
AS $$
DECLARE actor uuid := auth.uid(); result public.patients;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication is required'; END IF;
  PERFORM 1 FROM public.clinics WHERE id = p_clinic_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patient clinical profile is unavailable'; END IF;
  PERFORM 1 FROM public.clinic_memberships WHERE clinic_id = p_clinic_id AND user_id = actor
    AND is_active AND role IN ('admin', 'doctor', 'receptionist') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active same-clinic staff recording is required'; END IF;
  SELECT * INTO result FROM public.patients WHERE clinic_id = p_clinic_id AND id = p_patient_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_clinic_staff(p_clinic_id) THEN
    RAISE EXCEPTION 'Patient clinical profile is unavailable';
  END IF;
  IF p_expected_version IS DISTINCT FROM result.clinical_profile_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0022', MESSAGE = 'Clinical profile changed. Reload and review the latest version before saving.';
  END IF;
  UPDATE public.patients SET allergies = p_allergies, current_medications = p_current_medications,
    medical_history = p_medical_history, previous_surgery = p_previous_surgery, family_history = p_family_history,
    dental_history = p_dental_history, relevant_habits = p_relevant_habits, pregnancy_status = p_pregnancy_status
  WHERE clinic_id = p_clinic_id AND id = p_patient_id RETURNING * INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.update_patient_clinical_profile(uuid, uuid, integer, text, text, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_patient_clinical_profile(uuid, uuid, integer, text, text, text, text, text, text, text, text)
  TO authenticated;

-- Existing audit function is replaced below with only its patient branch changed.

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
      event_metadata := jsonb_build_object('clinical_profile_version', NEW.clinical_profile_version);
    ELSE
      SELECT COALESCE(array_agg(fields.key ORDER BY fields.key), ARRAY[]::text[])
      INTO changed_fields
      FROM jsonb_each(to_jsonb(NEW)) AS fields(key, value)
      WHERE fields.key NOT IN ('created_at', 'updated_at', 'clinical_profile_version')
        AND (to_jsonb(OLD) -> fields.key) IS DISTINCT FROM fields.value;
      IF cardinality(changed_fields) = 0 THEN
        RETURN NULL;
      END IF;
      event_action := 'updated';
      event_metadata := jsonb_build_object('changed_fields', to_jsonb(changed_fields));
      IF NEW.clinical_profile_version <> OLD.clinical_profile_version THEN
        event_metadata := event_metadata || jsonb_build_object('clinical_profile_version', NEW.clinical_profile_version);
      END IF;
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
