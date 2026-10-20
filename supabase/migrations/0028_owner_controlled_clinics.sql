-- Owner-controlled provisioning. Existing tenants remain active and intact.
BEGIN;
CREATE TABLE public.platform_owners (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_owners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_owners FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.clinics ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('pending','active','suspended'));
ALTER TABLE public.clinics ALTER COLUMN lifecycle_status SET DEFAULT 'pending';

CREATE FUNCTION public.is_platform_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
  SELECT EXISTS(SELECT 1 FROM public.platform_owners WHERE user_id=auth.uid());
$$;
CREATE FUNCTION public.clinic_is_active(p_clinic_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.clinics WHERE id=p_clinic_id AND lifecycle_status='active');
$$;
CREATE FUNCTION public.require_active_clinic(p_clinic_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Serialize per clinic before downstream locks; avoids lock upgrades in
  -- legacy RPCs and orders suspension against in-flight clinic operations.
  PERFORM 1 FROM public.clinics WHERE id=p_clinic_id AND lifecycle_status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clinic access is unavailable' USING ERRCODE='42501'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.is_platform_owner(), public.clinic_is_active(uuid), public.require_active_clinic(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.is_platform_owner(), public.clinic_is_active(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.bootstrap_clinic(p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Clinic provisioning requires the Platform Owner' USING ERRCODE='42501'; END;
$$;
REVOKE ALL ON FUNCTION public.bootstrap_clinic(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE INSERT,DELETE ON public.clinics FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.guard_clinic_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status THEN
    IF NOT public.is_platform_owner() THEN
      RAISE EXCEPTION 'Platform Owner authorization is required' USING ERRCODE='42501';
    END IF;
  ELSE
    PERFORM public.require_active_clinic(OLD.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_clinic_lifecycle() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER clinics_owner_lifecycle BEFORE INSERT OR UPDATE ON public.clinics
FOR EACH ROW EXECUTE FUNCTION public.guard_clinic_lifecycle();

CREATE FUNCTION public.owner_create_clinic(p_name text,p_admin_user_id uuid) RETURNS public.clinics
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
DECLARE result public.clinics;
BEGIN
  IF NOT public.is_platform_owner() THEN RAISE EXCEPTION 'Platform Owner authorization is required' USING ERRCODE='42501'; END IF;
  INSERT INTO public.profiles(id) VALUES(auth.uid()) ON CONFLICT(id) DO NOTHING;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Enter a clinic name of 1 to 200 characters'; END IF;
  PERFORM 1 FROM auth.users WHERE id=p_admin_user_id AND email_confirmed_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an existing confirmed administrator account'; END IF;
  IF EXISTS(SELECT 1 FROM public.clinic_memberships WHERE user_id=p_admin_user_id) THEN
    RAISE EXCEPTION 'Administrator already belongs to a clinic';
  END IF;
  INSERT INTO public.profiles(id) VALUES(p_admin_user_id) ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.clinics(name,lifecycle_status) VALUES(btrim(p_name),'pending') RETURNING * INTO result;
  INSERT INTO public.clinic_memberships(user_id,clinic_id,role,is_active) VALUES(p_admin_user_id,result.id,'admin',true);
  INSERT INTO public.audit_logs(clinic_id,actor_user_id,table_name,record_id,action,metadata)
  VALUES(result.id,auth.uid(),'clinics',result.id,'owner_provisioned',jsonb_build_object('status','pending','admin_user_id',p_admin_user_id));
  RETURN result;
END;
$$;
CREATE FUNCTION public.owner_set_clinic_status(p_clinic_id uuid,p_status text) RETURNS public.clinics
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
DECLARE result public.clinics; old_status text;
BEGIN
  IF NOT public.is_platform_owner() THEN RAISE EXCEPTION 'Platform Owner authorization is required' USING ERRCODE='42501'; END IF;
  SELECT * INTO result FROM public.clinics WHERE id=p_clinic_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clinic is unavailable'; END IF;
  old_status:=result.lifecycle_status;
  IF p_status IS NULL OR NOT ((old_status='pending' AND p_status='active') OR
     (old_status='active' AND p_status='suspended') OR (old_status='suspended' AND p_status='active')) THEN
    RAISE EXCEPTION 'Invalid clinic lifecycle transition';
  END IF;
  UPDATE public.clinics SET lifecycle_status=p_status,updated_at=now() WHERE id=p_clinic_id RETURNING * INTO result;
  INSERT INTO public.audit_logs(clinic_id,actor_user_id,table_name,record_id,action,metadata)
  VALUES(p_clinic_id,auth.uid(),'clinics',p_clinic_id,'lifecycle_changed',jsonb_build_object('old_status',old_status,'new_status',p_status));
  RETURN result;
END;
$$;
-- Deliberately returns administrative metadata only, not patient/clinical data.
CREATE FUNCTION public.owner_list_clinics() RETURNS TABLE(id uuid,name text,lifecycle_status text,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
BEGIN
  IF NOT public.is_platform_owner() THEN RAISE EXCEPTION 'Platform Owner authorization is required' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT c.id,c.name,c.lifecycle_status,c.created_at FROM public.clinics c ORDER BY c.created_at DESC;
END;
$$;
CREATE FUNCTION public.my_clinic_access() RETURNS TABLE(clinic_id uuid,lifecycle_status text,is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
  SELECT m.clinic_id,c.lifecycle_status,m.is_active FROM public.clinic_memberships m
  JOIN public.clinics c ON c.id=m.clinic_id WHERE m.user_id=auth.uid();
$$;
REVOKE ALL ON FUNCTION public.owner_create_clinic(text,uuid),public.owner_set_clinic_status(uuid,text),public.owner_list_clinics(),public.my_clinic_access() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.owner_create_clinic(text,uuid),public.owner_set_clinic_status(uuid,text),public.owner_list_clinics(),public.my_clinic_access() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_clinic_member(p_clinic_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
 SELECT public.clinic_is_active(p_clinic_id) AND EXISTS(SELECT 1 FROM public.clinic_memberships WHERE clinic_id=p_clinic_id AND user_id=auth.uid() AND is_active);
$$;
CREATE OR REPLACE FUNCTION public.is_clinic_member_as(p_clinic_id uuid,p_role public.user_role_enum) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
 SELECT public.clinic_is_active(p_clinic_id) AND EXISTS(SELECT 1 FROM public.clinic_memberships WHERE clinic_id=p_clinic_id AND user_id=auth.uid() AND is_active AND role=p_role);
$$;
CREATE OR REPLACE FUNCTION public.is_clinic_staff(p_clinic_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
 SELECT public.clinic_is_active(p_clinic_id) AND EXISTS(SELECT 1 FROM public.clinic_memberships WHERE clinic_id=p_clinic_id AND user_id=auth.uid() AND is_active AND role IN ('admin','doctor','receptionist'));
$$;

-- Additional restrictive policies cover legacy policies using raw memberships.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['patients','appointments','visits','prescriptions','investigations','invoices','payments','audit_logs','dental_chart_entries','clinic_memberships','patient_number_sequences','clinic_invoice_sequences','encounter_contexts','standalone_visit_lifecycle','patient_clinical_profile_versions','clinical_corrections','procedure_catalog','performed_procedures'] LOOP
  EXECUTE format('CREATE POLICY clinic_lifecycle_access ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING(public.clinic_is_active(clinic_id)) WITH CHECK(public.clinic_is_active(clinic_id))',t);
 END LOOP;
END;
$$;

-- RPC guard replacements follow. Original authorization/accounting logic is retained.
CREATE FUNCTION public.guard_active_tenant_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.require_active_clinic(OLD.clinic_id);
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN PERFORM public.require_active_clinic(OLD.clinic_id); END IF;
  PERFORM public.require_active_clinic(NEW.clinic_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_active_tenant_write() FROM PUBLIC,anon,authenticated,service_role;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['patients','appointments','visits','prescriptions','investigations','invoices','payments','dental_chart_entries','encounter_contexts','standalone_visit_lifecycle','patient_clinical_profile_versions','clinical_corrections','procedure_catalog','performed_procedures'] LOOP
  EXECUTE format('CREATE TRIGGER aa_active_clinic_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_active_tenant_write()',t);
 END LOOP;
END;
$$;

-- Lifecycle guard: admin_change_clinic_staff_role
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
  PERFORM public.require_active_clinic(p_clinic_id);
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

-- Lifecycle guard: admin_set_clinic_staff_active
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
  PERFORM public.require_active_clinic(p_clinic_id);
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

-- Lifecycle guard: update_clinic_currency
CREATE OR REPLACE FUNCTION public.update_clinic_currency(
  p_clinic_id uuid,
  p_currency text
)
RETURNS public.clinics
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  updated_clinic public.clinics;
BEGIN
  PERFORM public.require_active_clinic(p_clinic_id);
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;

  IF p_clinic_id IS NULL THEN
    RAISE EXCEPTION 'Clinic ID is required';
  END IF;

  IF p_currency IS NULL OR p_currency NOT IN ('TZS', 'KES', 'UGX', 'USD') THEN
    RAISE EXCEPTION 'Unsupported clinic currency';
  END IF;

  UPDATE public.clinics AS clinic
  SET currency = p_currency
  WHERE clinic.id = p_clinic_id
    AND EXISTS (
      SELECT 1
      FROM public.clinic_memberships AS membership
      WHERE membership.clinic_id = clinic.id
        AND membership.user_id = current_user_id
        AND membership.role = 'admin'
        AND membership.is_active
    )
  RETURNING clinic.* INTO updated_clinic;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'An active clinic administrator membership is required';
  END IF;

  RETURN updated_clinic;
END;
$$;

-- Lifecycle guard: provision_clinic_staff_membership
CREATE OR REPLACE FUNCTION public.provision_clinic_staff_membership(
  p_clinic_id uuid,
  p_user_id uuid,
  p_display_name text,
  p_role public.user_role_enum,
  p_actor_user_id uuid
)
RETURNS public.clinic_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  target_auth_user_id uuid;
  actor_admin_id uuid;
  existing_membership_clinic_id uuid;
  created_membership public.clinic_memberships;
BEGIN
  PERFORM public.require_active_clinic(p_clinic_id);
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Trusted staff provisioning is required';
  END IF;
  IF p_clinic_id IS NULL OR p_user_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Clinic, Auth user, and verified actor IDs are required';
  END IF;
  IF p_role IS NULL OR p_role NOT IN (
    'admin'::public.user_role_enum,
    'doctor'::public.user_role_enum,
    'receptionist'::public.user_role_enum
  ) THEN
    RAISE EXCEPTION 'Only admin, doctor, and receptionist roles can be provisioned';
  END IF;

  PERFORM 1
  FROM public.clinics AS clinic
  WHERE clinic.id = p_clinic_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target clinic was not found';
  END IF;

  SELECT membership.user_id INTO actor_admin_id
  FROM public.clinic_memberships AS membership
  WHERE membership.clinic_id = p_clinic_id
    AND membership.user_id = p_actor_user_id
    AND membership.role = 'admin'::public.user_role_enum
    AND membership.is_active
  FOR SHARE;
  IF actor_admin_id IS NULL THEN
    RAISE EXCEPTION 'Verified actor must be an active administrator of the target clinic';
  END IF;

  SELECT auth_user.id INTO target_auth_user_id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR UPDATE;
  IF target_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'Target Auth user was not found';
  END IF;

  SELECT membership.clinic_id INTO existing_membership_clinic_id
  FROM public.clinic_memberships AS membership
  WHERE membership.user_id = p_user_id
    AND membership.clinic_id = p_clinic_id;
  IF existing_membership_clinic_id IS NOT NULL THEN
    RAISE EXCEPTION 'Target Auth user already has a membership in this clinic';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Target Auth user already belongs to another clinic';
  END IF;

  INSERT INTO public.profiles AS existing_profile (id, display_name)
  VALUES (p_user_id, NULLIF(btrim(p_display_name), ''))
  ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      updated_at = now()
  WHERE NULLIF(btrim(existing_profile.display_name), '') IS NULL
    AND EXCLUDED.display_name IS NOT NULL;

  INSERT INTO public.clinic_memberships (user_id, clinic_id, role, is_active)
  VALUES (p_user_id, p_clinic_id, p_role, true)
  RETURNING * INTO created_membership;

  INSERT INTO public.audit_logs (
    clinic_id, actor_user_id, table_name, record_id, action, metadata
  )
  VALUES (
    p_clinic_id,
    actor_admin_id,
    'clinic_memberships',
    p_user_id,
    'provisioned',
    jsonb_build_object('role', p_role, 'is_active', true)
  );

  RETURN created_membership;
END;
$$;

-- Lifecycle guard: start_encounter_context
CREATE OR REPLACE FUNCTION public.start_encounter_context(p_clinic_id uuid, p_patient_id uuid)
RETURNS public.encounter_contexts LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  actor_id uuid := auth.uid();
  result public.encounter_contexts;
BEGIN
  PERFORM public.require_active_clinic(p_clinic_id);
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

-- Lifecycle guard: book_encounter_appointment
CREATE OR REPLACE FUNCTION public.book_encounter_appointment(
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
  PERFORM public.require_active_clinic((SELECT clinic_id FROM public.encounter_contexts WHERE id=p_encounter_id));
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

-- Lifecycle guard: start_consultation
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
  PERFORM public.require_active_clinic((SELECT clinic_id FROM public.appointments WHERE id=p_appointment_id));
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

-- Lifecycle guard: exit_appointment_queue
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
  PERFORM public.require_active_clinic((SELECT clinic_id FROM public.appointments WHERE id=p_appointment_id));
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

-- Lifecycle guard: save_consultation
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
  PERFORM public.require_active_clinic((SELECT clinic_id FROM public.visits WHERE id=p_visit_id));
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

-- Lifecycle guard: complete_consultation
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
  PERFORM public.require_active_clinic((SELECT clinic_id FROM public.visits WHERE id=p_visit_id));
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

-- Lifecycle guard: finalize_standalone_visit
CREATE OR REPLACE FUNCTION public.finalize_standalone_visit(p_visit_id uuid)
RETURNS public.standalone_visit_lifecycle LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE actor uuid := auth.uid(); v public.visits; result public.standalone_visit_lifecycle; actor_role public.user_role_enum;
BEGIN
  PERFORM public.require_active_clinic((SELECT clinic_id FROM public.visits WHERE id=p_visit_id));
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

-- Lifecycle guard: create_invoice
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
  PERFORM public.require_active_clinic(p_clinic_id);
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_total IN (
    'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
  ) THEN
    RAISE EXCEPTION 'Invoice total must be finite';
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

-- Lifecycle guard: record_payment
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
  PERFORM public.require_active_clinic((SELECT clinic_id FROM public.invoices WHERE id=p_invoice_id));
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_amount IN (
    'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
  ) THEN
    RAISE EXCEPTION 'Payment amount must be finite';
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
  IF invoice_row.subtotal IN (
       'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
     )
     OR invoice_row.discount IN (
       'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
     )
     OR invoice_row.total IN (
       'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
     )
     OR invoice_row.amount_paid IN (
       'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
     )
     OR invoice_row.balance IN (
       'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
     ) THEN
    RAISE EXCEPTION 'Invoice financial amounts must be finite before recording payment';
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

-- Lifecycle guard: update_patient_clinical_profile
CREATE OR REPLACE FUNCTION public.update_patient_clinical_profile(
  p_clinic_id uuid, p_patient_id uuid, p_expected_version integer,
  p_allergies text, p_current_medications text, p_medical_history text, p_previous_surgery text,
  p_family_history text, p_dental_history text, p_relevant_habits text, p_pregnancy_status text
)
RETURNS public.patients LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth
AS $$
DECLARE actor uuid := auth.uid(); result public.patients;
BEGIN
  PERFORM public.require_active_clinic(p_clinic_id);
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

-- Lifecycle guard: manage_procedure_catalog
CREATE OR REPLACE FUNCTION public.manage_procedure_catalog(
  p_clinic_id uuid, p_code text, p_name text, p_category text, p_active boolean DEFAULT true
)
RETURNS public.procedure_catalog LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth AS $$
DECLARE actor uuid := auth.uid(); result public.procedure_catalog; old_active boolean;
BEGIN
  PERFORM public.require_active_clinic(p_clinic_id);
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

-- Lifecycle guard: install_dental_procedure_template
CREATE OR REPLACE FUNCTION public.install_dental_procedure_template(p_clinic_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth AS $$
DECLARE item record; inserted integer := 0;
BEGIN
  PERFORM public.require_active_clinic(p_clinic_id);
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

-- Lifecycle guard: record_performed_procedure
CREATE OR REPLACE FUNCTION public.record_performed_procedure(
  p_visit_id uuid, p_catalog_id uuid, p_quantity integer DEFAULT 1,
  p_tooth_number integer DEFAULT NULL, p_note text DEFAULT NULL,
  p_supersedes_id uuid DEFAULT NULL, p_reason text DEFAULT NULL
)
RETURNS public.performed_procedures LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth AS $$
DECLARE actor uuid := auth.uid(); v public.visits; a public.appointments; catalog public.procedure_catalog;
  original public.performed_procedures; result public.performed_procedures; actor_role public.user_role_enum; lifecycle text;
BEGIN
  PERFORM public.require_active_clinic((SELECT clinic_id FROM public.visits WHERE id=p_visit_id));
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

-- Lifecycle guard: procedure_activity_report
CREATE OR REPLACE FUNCTION public.procedure_activity_report(p_clinic_id uuid, p_start_date date, p_end_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth AS $$
DECLARE zone text; result jsonb;
BEGIN
  PERFORM public.require_active_clinic(p_clinic_id);
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

-- Lifecycle guard: correct_dental_chart_entry
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
  PERFORM public.require_active_clinic((SELECT clinic_id FROM public.dental_chart_entries WHERE id=p_entry_id));
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

-- Lifecycle guard: correct_clinical_record
CREATE OR REPLACE FUNCTION public.correct_clinical_record(p_kind text,p_record_id uuid,p_action text,
  p_expected_revision integer,p_snapshot jsonb,p_reason text,p_admin_recovery boolean DEFAULT false)
RETURNS public.clinical_corrections LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
DECLARE
  actor uuid:=auth.uid(); v public.visits; a public.appointments; target_visit uuid;
  author uuid; recorder uuid; latest public.clinical_corrections; result public.clinical_corrections;
  allowed text[]; item record; r public.prescriptions; i public.investigations; narrative public.visits;
  lifecycle text; caller_role public.user_role_enum; payload jsonb; actor_name text;
BEGIN
  PERFORM public.require_active_clinic((CASE p_kind WHEN 'visit' THEN (SELECT clinic_id FROM public.visits WHERE id=p_record_id) WHEN 'prescription' THEN (SELECT clinic_id FROM public.prescriptions WHERE id=p_record_id) WHEN 'investigation' THEN (SELECT clinic_id FROM public.investigations WHERE id=p_record_id) WHEN 'procedure' THEN (SELECT clinic_id FROM public.performed_procedures WHERE id=p_record_id) WHEN 'dental' THEN (SELECT clinic_id FROM public.dental_chart_entries WHERE id=p_record_id) END));
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

COMMIT;
