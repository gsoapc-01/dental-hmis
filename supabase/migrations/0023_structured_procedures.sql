-- Clinic-owned classification and immutable evidence of procedures performed.
-- No historical procedure is inferred or fabricated; no billing data is changed.
BEGIN;

CREATE TABLE public.procedure_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 150),
  category text NOT NULL CHECK (char_length(btrim(category)) BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  UNIQUE (clinic_id, id), UNIQUE (clinic_id, code)
);
CREATE TABLE public.performed_procedures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  procedure_catalog_id uuid NOT NULL,
  procedure_code text NOT NULL,
  procedure_name text NOT NULL,
  category text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  tooth_number integer CHECK (tooth_number BETWEEN 11 AND 18 OR tooth_number BETWEEN 21 AND 28
    OR tooth_number BETWEEN 31 AND 38 OR tooth_number BETWEEN 41 AND 48
    OR tooth_number BETWEEN 51 AND 55 OR tooth_number BETWEEN 61 AND 65
    OR tooth_number BETWEEN 71 AND 75 OR tooth_number BETWEEN 81 AND 85),
  note text CHECK (char_length(note) <= 1000),
  performed_at timestamptz NOT NULL,
  clinical_author_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recorded_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  supersedes_id uuid UNIQUE,
  correction_reason text,
  UNIQUE (clinic_id, visit_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES public.visits(clinic_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (clinic_id, procedure_catalog_id) REFERENCES public.procedure_catalog(clinic_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (clinic_id, visit_id, supersedes_id) REFERENCES public.performed_procedures(clinic_id, visit_id, id) ON DELETE RESTRICT,
  CHECK ((supersedes_id IS NULL AND correction_reason IS NULL) OR
    (supersedes_id IS NOT NULL AND char_length(btrim(correction_reason)) BETWEEN 1 AND 500 AND correction_reason IS NOT NULL)),
  CHECK (procedure_code <> 'CONSULTATION_ONLY' OR (quantity = 1 AND tooth_number IS NULL))
);
CREATE INDEX performed_procedures_visit ON public.performed_procedures(clinic_id, visit_id);
CREATE INDEX performed_procedures_period ON public.performed_procedures(clinic_id, performed_at);
ALTER TABLE public.procedure_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performed_procedures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.procedure_catalog, public.performed_procedures FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.procedure_catalog, public.performed_procedures TO authenticated;
CREATE POLICY catalog_staff_read ON public.procedure_catalog FOR SELECT TO authenticated
  USING (public.is_clinic_staff(clinic_id));
CREATE POLICY performed_staff_read ON public.performed_procedures FOR SELECT TO authenticated
  USING (public.is_clinic_staff(clinic_id));

CREATE FUNCTION public.protect_procedure_history()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Recorded procedure history is immutable';
END;
$$;
CREATE TRIGGER performed_immutable BEFORE UPDATE OR DELETE ON public.performed_procedures
  FOR EACH ROW EXECUTE FUNCTION public.protect_procedure_history();
CREATE TRIGGER performed_no_truncate BEFORE TRUNCATE ON public.performed_procedures
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_procedure_history();
CREATE TRIGGER catalog_no_delete BEFORE DELETE ON public.procedure_catalog
  FOR EACH ROW EXECUTE FUNCTION public.protect_procedure_history();
CREATE TRIGGER catalog_no_truncate BEFORE TRUNCATE ON public.procedure_catalog
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_procedure_history();

-- Catalog identifiers/names remain stable. Correct taxonomy by deactivating and
-- adding a new code, preserving the meaning of existing reporting groups.
CREATE FUNCTION public.manage_procedure_catalog(
  p_clinic_id uuid, p_code text, p_name text, p_category text, p_active boolean DEFAULT true
)
RETURNS public.procedure_catalog LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth AS $$
DECLARE actor uuid := auth.uid(); result public.procedure_catalog; old_active boolean;
BEGIN
  PERFORM 1 FROM public.clinics WHERE id = p_clinic_id FOR KEY SHARE;
  PERFORM 1 FROM public.clinic_memberships WHERE clinic_id = p_clinic_id AND user_id = actor
    AND role = 'admin' AND is_active FOR SHARE;
  IF actor IS NULL OR NOT FOUND THEN RAISE EXCEPTION 'Active clinic administrator is required'; END IF;
  SELECT * INTO result FROM public.procedure_catalog WHERE clinic_id = p_clinic_id AND code = p_code FOR UPDATE;
  IF FOUND THEN
    IF result.name IS DISTINCT FROM btrim(p_name) OR result.category IS DISTINCT FROM btrim(p_category) THEN
      RAISE EXCEPTION 'Existing catalog names and categories are immutable; use a new code';
    END IF;
    old_active := result.active;
    UPDATE public.procedure_catalog SET active = p_active WHERE id = result.id RETURNING * INTO result;
    IF old_active = result.active THEN RETURN result; END IF;
  ELSE
    INSERT INTO public.procedure_catalog(clinic_id, code, name, category, active, created_by)
    VALUES (p_clinic_id, p_code, btrim(p_name), btrim(p_category), p_active, actor) RETURNING * INTO result;
  END IF;
  INSERT INTO public.audit_logs(clinic_id, actor_user_id, table_name, record_id, action, metadata)
  VALUES (p_clinic_id, actor, 'procedure_catalog', result.id,
    CASE WHEN old_active IS NULL THEN 'catalog_procedure_created' WHEN result.active THEN 'catalog_procedure_activated' ELSE 'catalog_procedure_deactivated' END,
    jsonb_build_object('procedure_catalog_id', result.id));
  RETURN result;
END;
$$;

-- Explicit opt-in template, scoped by the administrator's selected tenant.
-- No clinic names/IDs guessed and no automatic seed for other tenants.
CREATE FUNCTION public.install_dental_procedure_template(p_clinic_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth AS $$
DECLARE item record; inserted integer := 0;
BEGIN
  -- Serialize repeated installation and catalog administration for this clinic.
  PERFORM 1 FROM public.clinics WHERE id = p_clinic_id FOR UPDATE;
  IF auth.uid() IS NULL OR NOT public.is_clinic_member_as(p_clinic_id, 'admin') THEN
    RAISE EXCEPTION 'Active clinic administrator is required';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('CONSULTATION_ONLY','Consultation Only','Consultation'),
    ('XRAY','Dental X-Ray','Diagnostics'),
    ('SCALING_POLISHING','Scaling & Polishing','Preventive / Periodontal'),
    ('ROOT_PLANING','Scaling & Root Planing','Preventive / Periodontal'),
    ('FILLING_TEMPORARY','Temporary Filling','Restorative'),
    ('FILLING_PERMANENT','Permanent Filling','Restorative'),
    ('RESTORATION','Restoration','Restorative'),
    ('PIN_POST','Pin & Post Restoration','Restorative'),
    ('RCT_ANTERIOR','RCT (Anterior)','Endodontic'),('RCT_POSTERIOR','RCT (Posterior)','Endodontic'),
    ('EXTRACTION_SIMPLE','Extraction (Simple)','Oral Surgery'),
    ('EXTRACTION_POSTERIOR','Extraction (Posterior)','Oral Surgery'),
    ('EXTRACTION_COMPLEX','Extraction (Complex)','Oral Surgery'),
    ('DISIMPACTION','Disimpaction','Oral Surgery'),('FLAPECTOMY','Flapectomy','Oral Surgery'),
    ('CYSTECTOMY','Cystectomy','Oral Surgery'),('IMF','IMF','Oral Surgery'),('SPLINTING','Splinting','Oral Surgery'),
    ('IMPRESSION','Impression','Prosthodontic'),('PARTIAL_DENTURE','Partial Denture','Prosthodontic'),
    ('FULL_DENTURE','Full Denture','Prosthodontic'),('CROWN_ACRYLIC','Acrylic Crown','Prosthodontic'),
    ('CROWN_PFM','PFM Crown','Prosthodontic'),('CROWN_ZIRCONIA','Zirconia/Ceramic Crown','Prosthodontic'),
    ('BRIDGE','Dental Bridge','Prosthodontic'),('WHITENING','Teeth Whitening','Cosmetic'),
    ('VENEER_DIRECT','Direct Veneering','Cosmetic'),('VENEER_INDIRECT','Indirect Veneering','Cosmetic'),
    ('DRY_SOCKET','Dry Socket Management','Emergency'),('INFECTED_SOCKET','Infected Socket Management','Emergency'),
    ('ORTHODONTIC','Orthodontic Treatment','Orthodontic'),
    ('ORTHODONTIC_COMPLEX','Complex Orthodontic Treatment','Orthodontic'),('IMPLANT','Dental Implant','Implant')
  ) AS template(code, name, category) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.procedure_catalog WHERE clinic_id = p_clinic_id AND code = item.code) THEN
      PERFORM public.manage_procedure_catalog(p_clinic_id, item.code, item.name, item.category);
      inserted := inserted + 1;
    END IF;
  END LOOP;
  RETURN inserted;
END;
$$;

-- One narrow entry point for ordinary recording and append-only replacements.
CREATE FUNCTION public.record_performed_procedure(
  p_visit_id uuid, p_catalog_id uuid, p_quantity integer DEFAULT 1,
  p_tooth_number integer DEFAULT NULL, p_note text DEFAULT NULL,
  p_supersedes_id uuid DEFAULT NULL, p_reason text DEFAULT NULL
)
RETURNS public.performed_procedures LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth AS $$
DECLARE actor uuid := auth.uid(); v public.visits; a public.appointments; catalog public.procedure_catalog;
  original public.performed_procedures; result public.performed_procedures; actor_role public.user_role_enum; lifecycle text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication is required'; END IF;
  SELECT * INTO v FROM public.visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Visit is unavailable'; END IF;
  PERFORM 1 FROM public.clinics WHERE id = v.clinic_id FOR KEY SHARE;
  -- Exactly the consultation's appointment-before-visit order. Taking UPDATE
  -- on the visit also serializes standalone recording, corrections and closure.
  IF v.appointment_id IS NOT NULL THEN
    SELECT * INTO a FROM public.appointments WHERE id = v.appointment_id FOR UPDATE;
    IF NOT FOUND OR a.clinic_id <> v.clinic_id OR a.patient_id <> v.patient_id
      OR a.doctor_id IS DISTINCT FROM v.doctor_id THEN RAISE EXCEPTION 'Invalid consultation context'; END IF;
    IF (p_supersedes_id IS NULL AND a.status <> 'in_progress') OR
       (p_supersedes_id IS NOT NULL AND a.status NOT IN ('in_progress', 'completed')) THEN
      RAISE EXCEPTION 'Ordinary recording requires an in-progress consultation';
    END IF;
  END IF;
  SELECT * INTO v FROM public.visits WHERE id = p_visit_id FOR UPDATE;
  IF v.appointment_id IS NULL THEN
    SELECT state INTO lifecycle FROM public.standalone_visit_lifecycle WHERE clinic_id = v.clinic_id AND visit_id = v.id FOR UPDATE;
    IF lifecycle IS NULL OR (p_supersedes_id IS NULL AND lifecycle <> 'saved') THEN
      RAISE EXCEPTION 'Ordinary recording requires a saved unfinished standalone visit';
    END IF;
  END IF;
  PERFORM 1 FROM public.clinic_memberships WHERE clinic_id = v.clinic_id AND user_id IN (actor, v.doctor_id)
    ORDER BY user_id FOR SHARE;
  SELECT role INTO actor_role FROM public.clinic_memberships WHERE clinic_id = v.clinic_id AND user_id = actor AND is_active;
  IF actor_role IS NULL OR actor_role NOT IN ('admin', 'doctor') OR (actor_role = 'doctor' AND actor <> v.doctor_id)
    OR NOT EXISTS (SELECT 1 FROM public.clinic_memberships WHERE clinic_id = v.clinic_id AND user_id = v.doctor_id
      AND is_active AND (role = 'doctor' OR (role = 'admin' AND v.appointment_id IS NULL AND user_id = actor)))
    OR NOT EXISTS (SELECT 1 FROM public.patients WHERE clinic_id = v.clinic_id AND id = v.patient_id) THEN
    RAISE EXCEPTION 'Active assigned doctor or clinic administrator is required';
  END IF;
  IF p_supersedes_id IS NOT NULL THEN
    SELECT * INTO original FROM public.performed_procedures WHERE id = p_supersedes_id AND clinic_id = v.clinic_id AND visit_id = v.id FOR UPDATE;
    IF NOT FOUND OR original.recorded_by <> actor THEN
      RAISE EXCEPTION 'Only the active doctor or administrator who recorded the procedure can correct it';
    END IF;
    IF EXISTS (SELECT 1 FROM public.performed_procedures WHERE supersedes_id = original.id) THEN
      RAISE EXCEPTION 'Procedure already corrected; refresh and correct its current replacement';
    END IF;
    IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'Enter a correction reason of 1 to 500 characters';
    END IF;
  ELSIF p_reason IS NOT NULL THEN RAISE EXCEPTION 'Correction reason requires an original procedure'; END IF;
  SELECT * INTO catalog FROM public.procedure_catalog WHERE id = p_catalog_id AND clinic_id = v.clinic_id FOR SHARE;
  IF NOT FOUND OR (NOT catalog.active AND (p_supersedes_id IS NULL OR original.procedure_catalog_id <> catalog.id)) THEN
    RAISE EXCEPTION 'Choose an active procedure from this clinic catalog';
  END IF;
  IF catalog.code = 'CONSULTATION_ONLY' AND EXISTS (
    SELECT 1 FROM public.performed_procedures r WHERE r.visit_id = v.id AND r.procedure_code = 'CONSULTATION_ONLY'
      AND r.id IS DISTINCT FROM p_supersedes_id AND NOT EXISTS (SELECT 1 FROM public.performed_procedures c WHERE c.supersedes_id = r.id)
  ) THEN RAISE EXCEPTION 'Consultation Only is already recorded for this visit'; END IF;
  INSERT INTO public.performed_procedures(clinic_id, visit_id, procedure_catalog_id, procedure_code, procedure_name,
    category, quantity, tooth_number, note, performed_at, clinical_author_id, recorded_by, recorded_at, supersedes_id, correction_reason)
  VALUES (v.clinic_id, v.id, catalog.id, catalog.code, catalog.name, catalog.category, p_quantity, p_tooth_number,
    NULLIF(btrim(p_note), ''), COALESCE(original.performed_at, clock_timestamp()), v.doctor_id, actor, clock_timestamp(),
    p_supersedes_id, CASE WHEN p_supersedes_id IS NOT NULL THEN btrim(p_reason) ELSE NULL END) RETURNING * INTO result;
  INSERT INTO public.audit_logs(clinic_id, actor_user_id, table_name, record_id, action, metadata)
  VALUES (v.clinic_id, actor, 'performed_procedures', result.id,
    CASE WHEN p_supersedes_id IS NULL THEN 'procedure_recorded' ELSE 'procedure_corrected' END,
    jsonb_build_object('visit_id', v.id, 'patient_id', v.patient_id, 'procedure_catalog_id', catalog.id, 'supersedes_id', p_supersedes_id));
  RETURN result;
END;
$$;

-- Boundary triggers cover the existing RPCs without replacing 0021 workflows.
-- Existing completed/finalized history is unaffected; only new transitions.
CREATE FUNCTION public.require_visit_procedure()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE target_visit_id uuid; tenant_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'appointments' THEN
    IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN RETURN NEW; END IF;
    SELECT v.id INTO target_visit_id FROM public.visits v WHERE v.appointment_id = NEW.id AND v.clinic_id = NEW.clinic_id FOR SHARE;
    tenant_id := NEW.clinic_id;
  ELSE
    IF NEW.state <> 'finalized' OR OLD.state = 'finalized' THEN RETURN NEW; END IF;
    target_visit_id := NEW.visit_id; tenant_id := NEW.clinic_id;
  END IF;
  IF target_visit_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.performed_procedures r
    WHERE r.clinic_id = tenant_id AND r.visit_id = target_visit_id
      AND NOT EXISTS (SELECT 1 FROM public.performed_procedures c WHERE c.supersedes_id = r.id)) THEN
    RAISE EXCEPTION 'Record at least one procedure or Consultation Only before closing this visit.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appointments_require_procedure BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.require_visit_procedure();
CREATE TRIGGER standalone_require_procedure BEFORE UPDATE ON public.standalone_visit_lifecycle
  FOR EACH ROW EXECUTE FUNCTION public.require_visit_procedure();

-- One SQL statement gives coherent totals and detail at one MVCC snapshot.
-- Period uses clinic-local inclusive dates, including DST-safe midnight bounds.
CREATE FUNCTION public.procedure_activity_report(p_clinic_id uuid, p_start_date date, p_end_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth AS $$
DECLARE zone text; result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_clinic_member_as(p_clinic_id, 'admin') OR public.is_clinic_member_as(p_clinic_id, 'receptionist')) THEN
    RAISE EXCEPTION 'Existing clinic Reports access is required';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_start_date > p_end_date THEN RAISE EXCEPTION 'Choose a valid report period'; END IF;
  SELECT timezone INTO zone FROM public.clinics WHERE id = p_clinic_id;
  WITH effective AS (
    SELECT r.*, v.patient_id, lower(btrim(COALESCE(p.gender, ''))) AS gender
    FROM public.performed_procedures r JOIN public.visits v ON v.clinic_id = r.clinic_id AND v.id = r.visit_id
    JOIN public.patients p ON p.clinic_id = v.clinic_id AND p.id = v.patient_id
    WHERE r.clinic_id = p_clinic_id AND r.performed_at >= (p_start_date::timestamp AT TIME ZONE zone)
      AND r.performed_at < ((p_end_date + 1)::timestamp AT TIME ZONE zone)
      AND NOT EXISTS (SELECT 1 FROM public.performed_procedures c WHERE c.supersedes_id = r.id)
  ), groups AS (
    SELECT procedure_catalog_id, procedure_code, procedure_name, category, sum(quantity) units, count(*) records,
      count(DISTINCT patient_id) patients,
      count(DISTINCT patient_id) FILTER (WHERE gender = 'male') male,
      count(DISTINCT patient_id) FILTER (WHERE gender = 'female') female,
      count(DISTINCT patient_id) FILTER (WHERE gender NOT IN ('male','female')) other
    FROM effective GROUP BY procedure_catalog_id, procedure_code, procedure_name, category
  ) SELECT jsonb_build_object('units', COALESCE(sum(quantity),0), 'records', count(*), 'patients', count(DISTINCT patient_id),
      'male', count(DISTINCT patient_id) FILTER (WHERE gender = 'male'),
      'female', count(DISTINCT patient_id) FILTER (WHERE gender = 'female'),
      'other', count(DISTINCT patient_id) FILTER (WHERE gender NOT IN ('male','female')),
      'rows', COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY procedure_name) FROM groups g),'[]'::jsonb))
    INTO result FROM effective;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_procedure_history(), public.require_visit_procedure(),
  public.manage_procedure_catalog(uuid,text,text,text,boolean), public.install_dental_procedure_template(uuid),
  public.record_performed_procedure(uuid,uuid,integer,integer,text,uuid,text), public.procedure_activity_report(uuid,date,date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_procedure_catalog(uuid,text,text,text,boolean),
  public.install_dental_procedure_template(uuid), public.record_performed_procedure(uuid,uuid,integer,integer,text,uuid,text),
  public.procedure_activity_report(uuid,date,date) TO authenticated;
COMMIT;
