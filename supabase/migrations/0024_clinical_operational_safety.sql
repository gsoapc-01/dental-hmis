-- Append-only clinical corrections and operational safety.
BEGIN;
CREATE OR REPLACE FUNCTION public.assign_patient_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  allocated_number bigint;
  next_existing_number bigint;
BEGIN
  -- Create the clinic counter if this is its first patient, then serialize
  -- allocation for this clinic with a row lock.
  INSERT INTO public.patient_number_sequences (clinic_id, next_number)
  VALUES (NEW.clinic_id, 1)
  ON CONFLICT (clinic_id) DO NOTHING;

  SELECT sequence_row.next_number
  INTO allocated_number
  FROM public.patient_number_sequences AS sequence_row
  WHERE sequence_row.clinic_id = NEW.clinic_id
  FOR UPDATE;

  -- Reconcile again inside the allocation lock so imported or legacy numeric
  -- rows can never cause a generated number to collide.
  SELECT COALESCE(
    MAX(CASE WHEN patient.patient_number ~ '^[0-9]+$' THEN patient.patient_number::bigint ELSE 0 END),
    0
  ) + 1
  INTO next_existing_number
  FROM public.patients AS patient
  WHERE patient.clinic_id = NEW.clinic_id;

  allocated_number := GREATEST(allocated_number, next_existing_number);

  UPDATE public.patient_number_sequences
  SET next_number = allocated_number + 1
  WHERE clinic_id = NEW.clinic_id;

  NEW.patient_number := lpad(allocated_number::text, GREATEST(3, length(allocated_number::text)), '0');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_patient_number() FROM PUBLIC,anon,authenticated,service_role;

CREATE UNIQUE INDEX prescriptions_correction_target ON public.prescriptions(clinic_id,visit_id,id);
CREATE UNIQUE INDEX investigations_correction_target ON public.investigations(clinic_id,visit_id,id);
CREATE UNIQUE INDEX dental_correction_target ON public.dental_chart_entries(clinic_id,visit_id,id);
CREATE TABLE public.clinical_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('visit','prescription','investigation','procedure','dental')),
  record_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  predecessor_id uuid,
  prescription_id uuid,
  investigation_id uuid,
  procedure_id uuid,
  dental_id uuid,
  FOREIGN KEY(clinic_id,visit_id,prescription_id) REFERENCES public.prescriptions(clinic_id,visit_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(clinic_id,visit_id,investigation_id) REFERENCES public.investigations(clinic_id,visit_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(clinic_id,visit_id,procedure_id) REFERENCES public.performed_procedures(clinic_id,visit_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(clinic_id,visit_id,dental_id) REFERENCES public.dental_chart_entries(clinic_id,visit_id,id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('amend','replace','withdraw')),
  snapshot jsonb,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  recorded_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  actor_display_name text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  admin_recovery boolean NOT NULL DEFAULT false,
  UNIQUE (clinic_id,kind,record_id,revision),
  UNIQUE (clinic_id,kind,record_id,id),
  FOREIGN KEY (clinic_id,visit_id) REFERENCES public.visits(clinic_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (clinic_id,kind,record_id,predecessor_id) REFERENCES public.clinical_corrections(clinic_id,kind,record_id,id) ON DELETE RESTRICT,
  CHECK ((revision=1 AND predecessor_id IS NULL) OR (revision>1 AND predecessor_id IS NOT NULL)),
  CHECK ((kind='visit' AND record_id=visit_id AND num_nonnulls(prescription_id,investigation_id,procedure_id,dental_id)=0 AND action='amend')
    OR (kind='prescription' AND prescription_id IS NOT NULL AND record_id=prescription_id AND num_nonnulls(prescription_id,investigation_id,procedure_id,dental_id)=1 AND action IN ('replace','withdraw'))
    OR (kind='investigation' AND investigation_id IS NOT NULL AND record_id=investigation_id AND num_nonnulls(prescription_id,investigation_id,procedure_id,dental_id)=1 AND action IN ('replace','withdraw'))
    OR (kind='procedure' AND procedure_id IS NOT NULL AND record_id=procedure_id AND num_nonnulls(prescription_id,investigation_id,procedure_id,dental_id)=1 AND action='withdraw')
    OR (kind='dental' AND dental_id IS NOT NULL AND record_id=dental_id AND num_nonnulls(prescription_id,investigation_id,procedure_id,dental_id)=1 AND action='withdraw')),
  CHECK ((action='withdraw' AND snapshot IS NULL) OR (action<>'withdraw' AND snapshot IS NOT NULL AND jsonb_typeof(snapshot)='object'))
);
CREATE INDEX clinical_corrections_visit ON public.clinical_corrections(clinic_id,visit_id);
ALTER TABLE public.clinical_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clinical_corrections FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.clinical_corrections TO authenticated;
CREATE POLICY corrections_staff_read ON public.clinical_corrections FOR SELECT TO authenticated
  USING (public.is_clinic_staff(clinic_id) AND (kind<>'dental' OR public.is_clinic_member_as(clinic_id,'admin') OR public.is_clinic_member_as(clinic_id,'doctor')));
CREATE TRIGGER corrections_immutable BEFORE UPDATE OR DELETE ON public.clinical_corrections
  FOR EACH ROW EXECUTE FUNCTION public.protect_procedure_history();
CREATE TRIGGER corrections_no_truncate BEFORE TRUNCATE ON public.clinical_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_procedure_history();

CREATE FUNCTION public.correct_clinical_record(p_kind text,p_record_id uuid,p_action text,
  p_expected_revision integer,p_snapshot jsonb,p_reason text,p_admin_recovery boolean DEFAULT false)
RETURNS public.clinical_corrections LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
DECLARE
  actor uuid:=auth.uid(); v public.visits; a public.appointments; target_visit uuid;
  author uuid; recorder uuid; latest public.clinical_corrections; result public.clinical_corrections;
  allowed text[]; item record; r public.prescriptions; i public.investigations; narrative public.visits;
  lifecycle text; caller_role public.user_role_enum; payload jsonb; actor_name text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication is required'; END IF;
  IF p_kind='visit' THEN target_visit:=p_record_id;
  ELSIF p_kind='prescription' THEN SELECT visit_id INTO target_visit FROM public.prescriptions WHERE id=p_record_id;
  ELSIF p_kind='investigation' THEN SELECT visit_id INTO target_visit FROM public.investigations WHERE id=p_record_id;
  ELSIF p_kind='procedure' THEN SELECT visit_id INTO target_visit FROM public.performed_procedures WHERE id=p_record_id;
  ELSIF p_kind='dental' THEN SELECT visit_id INTO target_visit FROM public.dental_chart_entries WHERE id=p_record_id;
  ELSE RAISE EXCEPTION 'Unsupported correction kind'; END IF;
  SELECT * INTO v FROM public.visits WHERE id=target_visit;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clinical record is unavailable'; END IF;
  -- Same clinic -> appointment -> visit order as 0021/0023. Staff mutations
  -- take clinic UPDATE, keeping authorization stable for this transaction.
  PERFORM 1 FROM public.clinics WHERE id=v.clinic_id FOR KEY SHARE;
  IF v.appointment_id IS NOT NULL THEN
    SELECT * INTO a FROM public.appointments WHERE id=v.appointment_id FOR UPDATE;
    IF NOT FOUND OR a.clinic_id<>v.clinic_id OR a.patient_id<>v.patient_id OR a.doctor_id IS DISTINCT FROM v.doctor_id
      OR a.status NOT IN ('in_progress','completed') THEN RAISE EXCEPTION 'Invalid consultation correction context'; END IF;
  END IF;
  SELECT * INTO v FROM public.visits WHERE id=target_visit FOR UPDATE;
  IF v.appointment_id IS NULL THEN
    SELECT state INTO lifecycle FROM public.standalone_visit_lifecycle WHERE clinic_id=v.clinic_id AND visit_id=v.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Standalone lifecycle is unavailable'; END IF;
  END IF;
  PERFORM 1 FROM public.clinic_memberships WHERE clinic_id=v.clinic_id AND user_id IN(actor,v.doctor_id) ORDER BY user_id FOR SHARE;
  SELECT m.role INTO caller_role FROM public.clinic_memberships m WHERE clinic_id=v.clinic_id AND user_id=actor AND is_active;
  IF caller_role IS NULL OR caller_role NOT IN ('admin','doctor') THEN RAISE EXCEPTION 'Active same-clinic clinical authorization is required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.patients WHERE clinic_id=v.clinic_id AND id=v.patient_id) THEN RAISE EXCEPTION 'Patient context mismatch'; END IF;
  author:=v.doctor_id; recorder:=v.recorded_by;
  IF p_kind='prescription' THEN SELECT recorded_by INTO recorder FROM public.prescriptions WHERE id=p_record_id AND clinic_id=v.clinic_id AND visit_id=v.id;
  ELSIF p_kind='investigation' THEN SELECT recorded_by INTO recorder FROM public.investigations WHERE id=p_record_id AND clinic_id=v.clinic_id AND visit_id=v.id;
  ELSIF p_kind='procedure' THEN
    SELECT recorded_by INTO recorder FROM public.performed_procedures WHERE id=p_record_id AND clinic_id=v.clinic_id AND visit_id=v.id;
    IF EXISTS(SELECT 1 FROM public.performed_procedures WHERE supersedes_id=p_record_id) THEN RAISE EXCEPTION 'Refresh and withdraw the effective replacement'; END IF;
  ELSIF p_kind='dental' THEN
    SELECT recorded_by INTO recorder FROM public.dental_chart_entries WHERE id=p_record_id AND clinic_id=v.clinic_id AND visit_id=v.id;
    IF EXISTS(SELECT 1 FROM public.dental_chart_entries WHERE supersedes_entry_id=p_record_id) THEN RAISE EXCEPTION 'Refresh and withdraw the effective replacement'; END IF;
  END IF;
  IF p_kind<>'visit' AND NOT FOUND THEN RAISE EXCEPTION 'Clinical target context mismatch'; END IF;
  IF p_admin_recovery IS NULL THEN RAISE EXCEPTION 'Choose the authorization mode'; END IF;
  IF p_admin_recovery THEN
    IF caller_role<>'admin' THEN RAISE EXCEPTION 'Only an active same-clinic administrator can perform recovery'; END IF;
  ELSE
    IF actor<>author OR (p_kind IN ('procedure','dental') AND recorder IS DISTINCT FROM actor)
      OR NOT EXISTS(SELECT 1 FROM public.clinic_memberships WHERE clinic_id=v.clinic_id AND user_id=author AND is_active AND (role='doctor' OR (role='admin' AND v.appointment_id IS NULL))) THEN
      RAISE EXCEPTION 'Assigned active author is required; administrator recovery must be explicit'; END IF;
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Enter a correction reason of 1 to 500 characters'; END IF;
  SELECT * INTO latest FROM public.clinical_corrections WHERE clinic_id=v.clinic_id AND kind=p_kind AND record_id=p_record_id ORDER BY revision DESC LIMIT 1;
  IF p_expected_revision IS DISTINCT FROM COALESCE(latest.revision,0) THEN RAISE EXCEPTION USING ERRCODE='P0024',MESSAGE='Clinical record changed. Refresh and review before correcting.'; END IF;
  IF latest.action='withdraw' THEN RAISE EXCEPTION 'Withdrawn evidence cannot be replaced or restored'; END IF;
  IF p_kind='visit' THEN
    IF p_action IS DISTINCT FROM 'amend' OR (v.appointment_id IS NOT NULL AND a.status<>'completed') THEN RAISE EXCEPTION 'Use normal consultation save until completion'; END IF;
    allowed:=ARRAY['chief_complaint','hpi','examination','assessment','treatment_plan','clinical_notes','follow_up_date','follow_up_instructions'];
  ELSIF p_kind='prescription' THEN allowed:=ARRAY['medicine','strength','dose','route','frequency','duration','quantity','instructions'];
  ELSIF p_kind='investigation' THEN
    SELECT * INTO i FROM public.investigations WHERE id=p_record_id;
    IF i.result IS NOT NULL OR i.result_date IS NOT NULL OR COALESCE(i.status,'requested') NOT IN ('requested','pending') THEN RAISE EXCEPTION 'Result-bearing investigations require a separate result correction workflow'; END IF;
    allowed:=ARRAY['investigation_type','notes'];
  END IF;
  IF p_action='withdraw' THEN
    IF p_kind='visit' OR p_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Invalid withdrawal payload'; END IF;
  ELSIF (p_kind='visit' AND p_action='amend') OR (p_kind IN ('prescription','investigation') AND p_action='replace') THEN
    IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_snapshot))<>cardinality(allowed)
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_snapshot) k WHERE NOT k=ANY(allowed)) THEN RAISE EXCEPTION 'Supply exactly the supported clinical fields'; END IF;
    FOR item IN SELECT key,value FROM jsonb_each(p_snapshot) LOOP
      IF item.key='quantity' THEN
        IF jsonb_typeof(item.value) NOT IN ('number','null') THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
      ELSIF jsonb_typeof(item.value) NOT IN ('string','null') OR length(item.value#>>'{}')>4000 THEN RAISE EXCEPTION 'Invalid clinical text'; END IF;
    END LOOP;
    IF p_kind='visit' THEN SELECT * INTO narrative FROM jsonb_populate_record(NULL::public.visits,p_snapshot);
    ELSIF p_kind='prescription' THEN
      SELECT * INTO r FROM jsonb_populate_record(NULL::public.prescriptions,p_snapshot);
      IF NULLIF(btrim(r.medicine),'') IS NULL OR (r.quantity IS NOT NULL AND r.quantity<=0) THEN RAISE EXCEPTION 'Medicine and positive optional quantity are required'; END IF;
    ELSE SELECT * INTO i FROM jsonb_populate_record(NULL::public.investigations,p_snapshot);
      IF NULLIF(btrim(i.investigation_type),'') IS NULL THEN RAISE EXCEPTION 'Investigation request is required'; END IF;
    END IF;
    payload:=p_snapshot;
  ELSE RAISE EXCEPTION 'Unsupported clinical correction action'; END IF;
  SELECT display_name INTO actor_name FROM public.profiles WHERE id=actor;
  INSERT INTO public.clinical_corrections(clinic_id,visit_id,kind,record_id,revision,predecessor_id,
    prescription_id,investigation_id,procedure_id,dental_id,action,snapshot,reason,recorded_by,actor_display_name,recorded_at,admin_recovery)
  VALUES(v.clinic_id,v.id,p_kind,p_record_id,COALESCE(latest.revision,0)+1,latest.id,
    CASE WHEN p_kind='prescription' THEN p_record_id END,CASE WHEN p_kind='investigation' THEN p_record_id END,
    CASE WHEN p_kind='procedure' THEN p_record_id END,CASE WHEN p_kind='dental' THEN p_record_id END,
    p_action,payload,btrim(p_reason),actor,actor_name,clock_timestamp(),p_admin_recovery) RETURNING * INTO result;
  INSERT INTO public.audit_logs(clinic_id,actor_user_id,table_name,record_id,action,metadata)
  VALUES(v.clinic_id,actor,'clinical_corrections',result.id,
    CASE p_kind WHEN 'visit' THEN 'visit_amended' WHEN 'prescription' THEN 'prescription_'||CASE p_action WHEN 'withdraw' THEN 'withdrawn' ELSE 'replaced' END
    WHEN 'investigation' THEN 'investigation_'||CASE p_action WHEN 'withdraw' THEN 'withdrawn' ELSE 'replaced' END
    WHEN 'procedure' THEN 'procedure_withdrawn' ELSE 'dental_entry_withdrawn' END,
    jsonb_build_object('visit_id',v.id,'patient_id',v.patient_id,'record_id',p_record_id,'predecessor_id',latest.id,'revision',result.revision,'admin_recovery',p_admin_recovery));
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.correct_clinical_record(text,uuid,text,integer,jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.correct_clinical_record(text,uuid,text,integer,jsonb,text,boolean) TO authenticated;

CREATE FUNCTION public.reject_withdrawn_predecessor() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE predecessor uuid; entity text;
BEGIN
  IF TG_TABLE_NAME='performed_procedures' THEN predecessor:=NEW.supersedes_id; entity:='procedure';
  ELSE predecessor:=NEW.supersedes_entry_id; entity:='dental'; END IF;
  IF predecessor IS NOT NULL AND EXISTS(SELECT 1 FROM public.clinical_corrections WHERE clinic_id=NEW.clinic_id AND kind=entity AND record_id=predecessor AND action='withdraw') THEN
    RAISE EXCEPTION 'Withdrawn evidence cannot be replaced or restored'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reject_withdrawn_predecessor() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER procedure_reject_withdrawn BEFORE INSERT ON public.performed_procedures FOR EACH ROW EXECUTE FUNCTION public.reject_withdrawn_predecessor();
CREATE TRIGGER dental_reject_withdrawn BEFORE INSERT ON public.dental_chart_entries FOR EACH ROW EXECUTE FUNCTION public.reject_withdrawn_predecessor();

CREATE FUNCTION public.guard_open_clinician_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE open_count bigint;
BEGIN
  IF OLD.role='doctor' AND (NEW.role<>'doctor' OR NOT NEW.is_active) THEN
    SELECT count(*) INTO open_count FROM public.appointments WHERE clinic_id=OLD.clinic_id AND doctor_id=OLD.user_id AND status='in_progress';
    IF open_count>0 THEN RAISE EXCEPTION 'This clinician has % open consultation(s). Complete those consultations before changing their access.',open_count; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_open_clinician_access() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER membership_open_consultations BEFORE UPDATE ON public.clinic_memberships FOR EACH ROW EXECUTE FUNCTION public.guard_open_clinician_access();

CREATE FUNCTION public.guard_appointment_operations() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='scheduled' AND NEW.status IN ('confirmed','arrived','cancelled','no_show')) OR
    (OLD.status='confirmed' AND NEW.status IN ('arrived','cancelled','no_show')) OR
    (OLD.status='arrived' AND NEW.status IN ('waiting','cancelled','no_show')) OR
    (OLD.status='waiting' AND NEW.status IN ('in_progress','cancelled','no_show')) OR
    (OLD.status='in_progress' AND NEW.status='completed')) THEN RAISE EXCEPTION 'Invalid appointment state transition'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status NOT IN ('scheduled','confirmed') THEN RAISE EXCEPTION 'New appointments must be scheduled or confirmed'; END IF;
  END IF;
  IF TG_OP='INSERT' OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id THEN
    IF NEW.doctor_id IS NOT NULL THEN
      PERFORM 1 FROM public.clinics WHERE id=NEW.clinic_id FOR KEY SHARE;
      PERFORM 1 FROM public.clinic_memberships WHERE clinic_id=NEW.clinic_id AND user_id=NEW.doctor_id AND role='doctor' AND is_active FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active doctor from this clinic'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_appointment_operations() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER appointments_operational_boundary BEFORE INSERT OR UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.guard_appointment_operations();



CREATE OR REPLACE FUNCTION public.require_visit_procedure()
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
      AND NOT EXISTS (SELECT 1 FROM public.performed_procedures c WHERE c.supersedes_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM public.clinical_corrections w WHERE w.clinic_id=r.clinic_id AND w.kind='procedure' AND w.record_id=r.id AND w.action='withdraw')) THEN
    RAISE EXCEPTION 'Record at least one procedure or Consultation Only before closing this visit.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.procedure_activity_report(p_clinic_id uuid, p_start_date date, p_end_date date)
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
      AND NOT EXISTS (SELECT 1 FROM public.clinical_corrections w WHERE w.clinic_id=r.clinic_id AND w.kind='procedure' AND w.record_id=r.id AND w.action='withdraw')
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

CREATE OR REPLACE FUNCTION public.record_performed_procedure(
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
      AND NOT EXISTS (SELECT 1 FROM public.clinical_corrections w WHERE w.clinic_id=r.clinic_id AND w.kind='procedure' AND w.record_id=r.id AND w.action='withdraw')
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
COMMIT;
