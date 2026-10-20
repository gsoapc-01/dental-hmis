-- DEVELOPMENT ONLY. Run whole file as postgres. Nothing is committed.
-- Replace THREE UUIDs with distinct authorized synthetic confirmed Auth users.
-- Administrator and outsider must have profiles and NO existing memberships.
-- Owner may have memberships. No existing Auth/profile rows are changed.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE milestone_0028_result(result text, checks integer, details text) ON COMMIT DROP;
DO $test$
DECLARE
 owner_id uuid := '6a1abd75-2d1a-4a69-bdb2-212472b75a8d';
 admin_id uuid := '8e16bc69-6ad3-4e2e-9359-2b8e51196481';
 outsider_id uuid := 'ebd47382-1688-4b1e-a36d-c6e5428fb291';
 c public.clinics; other_c public.clinics; p public.patients;
 invoice public.invoices; payment public.payments;
 saved_invoice jsonb; saved_patient jsonb;
 setting_name text; affected integer;
 checks integer:=0; succeeded boolean:=false; failure text;
BEGIN
 BEGIN
  IF current_user<>'postgres' THEN RAISE EXCEPTION 'Use SQL Editor postgres role'; END IF;
  IF owner_id=admin_id OR owner_id=outsider_id OR admin_id=outsider_id THEN RAISE EXCEPTION 'Distinct identities required'; END IF;
  IF (SELECT count(*) FROM auth.users u JOIN public.profiles AS fixture_profile ON fixture_profile.id=u.id
      WHERE u.id IN(owner_id,admin_id,outsider_id) AND u.email_confirmed_at IS NOT NULL)<>3 THEN
    RAISE EXCEPTION 'Confirmed synthetic identities/profiles required';
  END IF;
  IF EXISTS(SELECT 1 FROM public.clinic_memberships WHERE user_id IN(admin_id,outsider_id)) THEN RAISE EXCEPTION 'Use unassigned synthetic administrators'; END IF;
  INSERT INTO public.platform_owners(user_id) VALUES(owner_id) ON CONFLICT DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  c:=public.owner_create_clinic('SYNTHETIC 0028 A',admin_id);
  other_c:=public.owner_create_clinic('SYNTHETIC 0028 B',outsider_id);
  IF c.lifecycle_status<>'pending' THEN RAISE EXCEPTION 'New clinic not pending'; END IF;
  checks:=checks+1;
  -- Owner gets metadata only, not tenant patient access.
  IF public.is_clinic_staff(c.id) THEN RAISE EXCEPTION 'Owner gained tenant role'; END IF;
  checks:=checks+1;

  PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  IF EXISTS(SELECT 1 FROM public.clinics WHERE id=c.id) OR public.is_clinic_member(c.id) THEN RAISE EXCEPTION 'Pending clinic accessible'; END IF;
  checks:=checks+1;
  BEGIN PERFORM public.start_encounter_context(c.id,gen_random_uuid()); RAISE EXCEPTION 'Pending RPC accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;

  PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
  c:=public.owner_set_clinic_status(c.id,'active');
  other_c:=public.owner_set_clinic_status(other_c.id,'active');
  PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
  -- Same authenticated role/JWT subject remains in use across suspension below.
  IF NOT public.is_clinic_member_as(c.id,'admin') THEN RAISE EXCEPTION 'Initial administrator missing'; END IF;
  checks:=checks+1;
  BEGIN PERFORM public.owner_create_clinic('DENIED',admin_id); RAISE EXCEPTION 'Non-owner create accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  BEGIN PERFORM public.owner_set_clinic_status(c.id,'suspended'); RAISE EXCEPTION 'Non-owner status accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  BEGIN PERFORM public.owner_list_clinics(); RAISE EXCEPTION 'Non-owner list accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  BEGIN PERFORM public.bootstrap_clinic('DENIED'); RAISE EXCEPTION 'Bootstrap accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  BEGIN INSERT INTO public.platform_owners(user_id) VALUES(admin_id); RAISE EXCEPTION 'Owner escalation accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  BEGIN UPDATE public.clinics SET lifecycle_status='suspended' WHERE id=c.id; RAISE EXCEPTION 'Direct lifecycle update accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  UPDATE public.clinics SET name='SYNTHETIC 0028 SETTINGS', phone='0028'
  WHERE id=c.id RETURNING name INTO setting_name;
  IF setting_name IS DISTINCT FROM 'SYNTHETIC 0028 SETTINGS' THEN RAISE EXCEPTION 'Active admin settings update blocked'; END IF;
  checks:=checks+1;
  c:=public.update_clinic_currency(c.id,'KES');
  IF c.currency<>'KES' THEN RAISE EXCEPTION 'Active admin currency update blocked'; END IF;
  checks:=checks+1;
  IF EXISTS(SELECT 1 FROM public.clinics WHERE id=other_c.id) THEN RAISE EXCEPTION 'Cross-clinic read accepted'; END IF;
  checks:=checks+1;
  BEGIN PERFORM public.update_clinic_currency(other_c.id,'KES'); RAISE EXCEPTION 'Cross-clinic write accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%administrator%' THEN RAISE; END IF;
    checks:=checks+1;
  END;
  INSERT INTO public.patients(clinic_id,first_name,last_name) VALUES(c.id,'SYNTHETIC','0028') RETURNING * INTO p;
  invoice:=public.create_invoice(c.id,p.id,NULL,100);
  payment:=public.record_payment(invoice.id,20,'cash',NULL);
  SELECT to_jsonb(i) INTO saved_invoice FROM public.invoices i WHERE id=invoice.id;
  saved_patient:=to_jsonb(p);
  checks:=checks+1;

  PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
  c:=public.owner_set_clinic_status(c.id,'suspended');
  PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
  IF EXISTS(SELECT 1 FROM public.patients WHERE id=p.id) OR EXISTS(SELECT 1 FROM public.invoices WHERE id=invoice.id)
     OR public.is_clinic_member(c.id) THEN RAISE EXCEPTION 'Previously authenticated suspended user retained access'; END IF;
  checks:=checks+1;
  UPDATE public.clinics SET name='DENIED' WHERE id=c.id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'Suspended direct settings update accepted'; END IF;
  checks:=checks+1;
  BEGIN PERFORM public.update_clinic_currency(c.id,'USD'); RAISE EXCEPTION 'Suspended currency update accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  BEGIN PERFORM public.create_invoice(c.id,p.id,NULL,10); RAISE EXCEPTION 'Suspended billing accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  BEGIN PERFORM public.record_payment(invoice.id,10,'cash',NULL); RAISE EXCEPTION 'Suspended payment accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  BEGIN PERFORM public.start_encounter_context(c.id,p.id); RAISE EXCEPTION 'Suspended encounter accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  BEGIN PERFORM public.admin_set_clinic_staff_active(c.id,outsider_id,true); RAISE EXCEPTION 'Suspended staff RPC accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  -- Trusted provisioning is service-only; its lifecycle guard must also deny
  -- suspension even with a service-role JWT and verified admin actor.
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  -- BYPASSRLS must not bypass the row trigger, even with table UPDATE rights.
  BEGIN UPDATE public.clinics SET lifecycle_status='active' WHERE id=c.id; RAISE EXCEPTION 'RLS bypass changed lifecycle';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM<>'Platform Owner authorization is required' THEN RAISE; END IF;
    checks:=checks+1;
  END;
  BEGIN UPDATE public.clinics SET name='DENIED' WHERE id=c.id; RAISE EXCEPTION 'RLS bypass updated suspended settings';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM<>'Clinic access is unavailable' THEN RAISE; END IF;
    checks:=checks+1;
  END;
  BEGIN PERFORM public.provision_clinic_staff_membership(c.id,outsider_id,'Synthetic','doctor',admin_id); RAISE EXCEPTION 'Suspended trusted provisioning accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  EXECUTE 'RESET ROLE';
  -- Rows and individual membership activation are preserved.
  IF (SELECT to_jsonb(i) FROM public.invoices i WHERE id=invoice.id) IS DISTINCT FROM saved_invoice
    OR (SELECT to_jsonb(x) FROM public.patients x WHERE id=p.id) IS DISTINCT FROM saved_patient
    OR NOT EXISTS(SELECT 1 FROM public.payments WHERE id=payment.id)
    OR NOT EXISTS(SELECT 1 FROM public.clinic_memberships WHERE clinic_id=c.id AND user_id=admin_id AND is_active)
    THEN RAISE EXCEPTION 'Suspension modified tenant history or membership'; END IF;
  checks:=checks+1;
  PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  c:=public.owner_set_clinic_status(c.id,'active');
  PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
  IF NOT EXISTS(SELECT 1 FROM public.patients WHERE id=p.id) OR NOT EXISTS(SELECT 1 FROM public.invoices WHERE id=invoice.id)
    THEN RAISE EXCEPTION 'Reactivation did not restore access'; END IF;
  checks:=checks+1;
  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN PERFORM public.owner_list_clinics(); RAISE EXCEPTION 'Anonymous owner access accepted';
  EXCEPTION WHEN insufficient_privilege THEN checks:=checks+1; END;
  EXECUTE 'RESET ROLE';
  IF checks<>29 THEN RAISE EXCEPTION 'Incomplete test count: %',checks; END IF;
  RAISE EXCEPTION USING ERRCODE='ZX028',MESSAGE='rollback successful fixtures';
 EXCEPTION
  WHEN SQLSTATE 'ZX028' THEN succeeded:=true;
  WHEN OTHERS THEN failure:=SQLSTATE;
 END;
 EXECUTE 'RESET ROLE';
 IF EXISTS(SELECT 1 FROM public.clinics WHERE id IN(c.id,other_c.id)) THEN succeeded:=false; failure:='cleanup_failed'; END IF;
 INSERT INTO milestone_0028_result VALUES(CASE WHEN succeeded THEN 'PASS' ELSE 'FAIL' END,checks,
  CASE WHEN succeeded THEN 'Fixtures rolled back; concurrency and external email delivery NOT TESTED'
       ELSE 'Fixtures rolled back; failure SQLSTATE='||coalesce(failure,'unknown') END);
END;
$test$;
SELECT * FROM milestone_0028_result;
ROLLBACK;
