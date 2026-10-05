-- TEST SCRIPT ONLY: manually run the ENTIRE file in DEVELOPMENT SQL Editor.
-- Not a migration. Do not put this file in supabase/migrations or db-push it.
-- Use disposable, synthetic fixtures. No credentials or access tokens required.
-- Replace every value below with a UUID. Leave the configuration keys unchanged.
-- If execution stops on an error, issue ROLLBACK before doing anything else.

BEGIN;

-- ========================= CONFIGURATION SECTION =========================
SELECT set_config('m13_5a.configuration', $config$
{
  "admin": "ADMIN_A_UUID",
  "doctor": "DOCTOR_D1_UUID",
  "wrong_doctor": "DOCTOR_D2_UUID",
  "receptionist": "RECEPTIONIST_UUID",
  "other_clinic": "CLINIC_B_DOCTOR_UUID",
  "inactive": "INACTIVE_DOCTOR_UUID",
  "clinic": "CLINIC_A_UUID",
  "completed_visit": "V_COMPLETED_UUID",
  "open_visit": "V_OPEN_UUID",
  "prescription": "RX_UUID",
  "investigation": "INV_UUID",
  "completed_appointment": "A_COMPLETED_UUID",
  "waiting_appointment": "A_WAITING_UUID",
  "open_appointment": "A_OPEN_UUID",
  "audit": "AUDIT_ID_UUID"
}
$config$, true);
-- ======================= END CONFIGURATION SECTION =======================

-- Only configuration/session setup precedes this role switch. Every fixture
-- query and mutation attempt below runs with authenticated database privileges.
SET LOCAL ROLE authenticated;

DO $verification$
DECLARE
  cfg jsonb := current_setting('m13_5a.configuration')::jsonb;
  item record;
  test_case record;
  actor_key text;
  actor_id uuid;
  fixture_clinic_id uuid;
  membership public.clinic_memberships;
  completed_visit public.visits;
  open_visit public.visits;
  appointment public.appointments;
  rx public.prescriptions;
  inv public.investigations;
  audit public.audit_logs;
  completed_appointment_before jsonb;
  waiting_appointment_before jsonb;
  open_appointment_before jsonb;
  affected bigint;
  state text;
  error_message text;
  expected_message text;
  denial_count integer := 0;
  read_count integer := 0;
BEGIN
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'FAIL: database role must be authenticated, got %', current_user;
  END IF;

  -- Validate all placeholders before touching fixtures or attempting mutations.
  FOR item IN SELECT key, value FROM jsonb_each_text(cfg) LOOP
    BEGIN
      PERFORM item.value::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'FAIL: replace configuration placeholder for % with a UUID', item.key;
    END;
  END LOOP;
  fixture_clinic_id := (cfg->>'clinic')::uuid;
  IF (SELECT count(DISTINCT cfg->>k) FROM unnest(ARRAY[
        'admin', 'doctor', 'wrong_doctor', 'receptionist', 'other_clinic', 'inactive'
      ]) AS keys(k)) <> 6 THEN
    RAISE EXCEPTION 'FAIL: six different test user UUIDs are required';
  END IF;
  IF cfg->>'completed_visit' = cfg->>'open_visit'
     OR cfg->>'completed_appointment' = cfg->>'waiting_appointment'
     OR cfg->>'completed_appointment' = cfg->>'open_appointment'
     OR cfg->>'waiting_appointment' = cfg->>'open_appointment' THEN
    RAISE EXCEPTION 'FAIL: completed/open visits and the three appointments must be distinct';
  END IF;

  -- Self-membership reads work even for inactive users. Simulate each identity
  -- separately so no privileged preflight reads hide tenant-isolation mistakes.
  FOREACH actor_key IN ARRAY ARRAY[
    'admin', 'doctor', 'wrong_doctor', 'receptionist', 'other_clinic', 'inactive'
  ] LOOP
    actor_id := (cfg->>actor_key)::uuid;
    PERFORM set_config('request.jwt.claims', jsonb_build_object(
      'sub', actor_id::text, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF auth.uid() IS DISTINCT FROM actor_id OR auth.role() IS DISTINCT FROM 'authenticated' THEN
      RAISE EXCEPTION 'FAIL: JWT simulation mismatch for %', actor_key;
    END IF;

    IF actor_key = 'other_clinic' THEN
      IF EXISTS (SELECT 1 FROM public.clinic_memberships AS m
                 WHERE m.user_id = actor_id AND m.clinic_id = fixture_clinic_id)
         OR NOT EXISTS (SELECT 1 FROM public.clinic_memberships AS m
                        WHERE m.user_id = actor_id AND m.clinic_id <> fixture_clinic_id
                          AND m.role = 'doctor' AND m.is_active) THEN
        RAISE EXCEPTION 'FAIL: other-clinic actor needs an active doctor membership elsewhere and none in Clinic A';
      END IF;
    ELSE
      SELECT m.* INTO membership FROM public.clinic_memberships AS m
      WHERE m.user_id = actor_id AND m.clinic_id = fixture_clinic_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'FAIL: missing Clinic A membership for %', actor_key;
      END IF;
      IF membership.role::text <> CASE actor_key
           WHEN 'admin' THEN 'admin' WHEN 'receptionist' THEN 'receptionist'
           ELSE 'doctor' END
         OR membership.is_active IS DISTINCT FROM (actor_key <> 'inactive') THEN
        RAISE EXCEPTION 'FAIL: incorrect role/activation fixture for %', actor_key;
      END IF;
    END IF;
  END LOOP;

  actor_id := (cfg->>'admin')::uuid;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);

  SELECT v.* INTO completed_visit FROM public.visits AS v
  WHERE v.id = (cfg->>'completed_visit')::uuid;
  IF NOT FOUND OR completed_visit.clinic_id <> fixture_clinic_id
     OR completed_visit.doctor_id <> (cfg->>'doctor')::uuid
     OR completed_visit.appointment_id IS DISTINCT FROM (cfg->>'completed_appointment')::uuid THEN
    RAISE EXCEPTION 'FAIL: completed visit fixture is missing or incorrectly linked';
  END IF;
  SELECT v.* INTO open_visit FROM public.visits AS v
  WHERE v.id = (cfg->>'open_visit')::uuid;
  IF NOT FOUND OR open_visit.clinic_id <> fixture_clinic_id
     OR open_visit.doctor_id <> (cfg->>'doctor')::uuid
     OR open_visit.appointment_id IS DISTINCT FROM (cfg->>'open_appointment')::uuid THEN
    RAISE EXCEPTION 'FAIL: open visit fixture is missing or incorrectly linked';
  END IF;

  FOR item IN SELECT * FROM (VALUES
    ('completed_appointment', 'completed', completed_visit.patient_id),
    ('open_appointment', 'in_progress', open_visit.patient_id),
    ('waiting_appointment', 'waiting', NULL::uuid)
  ) AS fixtures(key, status, patient_id) LOOP
    SELECT a.* INTO appointment FROM public.appointments AS a
    WHERE a.id = (cfg->>item.key)::uuid;
    IF NOT FOUND OR appointment.clinic_id <> fixture_clinic_id
       OR appointment.doctor_id IS DISTINCT FROM (cfg->>'doctor')::uuid
       OR appointment.status::text <> item.status
       OR (item.patient_id IS NOT NULL AND appointment.patient_id <> item.patient_id)
       OR NOT EXISTS (SELECT 1 FROM public.patients AS p
                      WHERE p.id = appointment.patient_id AND p.clinic_id = fixture_clinic_id) THEN
      RAISE EXCEPTION 'FAIL: invalid appointment/patient fixture for %', item.key;
    END IF;
    IF item.key = 'waiting_appointment' AND EXISTS (
      SELECT 1 FROM public.visits AS v WHERE v.appointment_id = appointment.id
    ) THEN
      RAISE EXCEPTION 'FAIL: waiting appointment must not already have a visit';
    END IF;
    CASE item.key
      WHEN 'completed_appointment' THEN completed_appointment_before := to_jsonb(appointment);
      WHEN 'open_appointment' THEN open_appointment_before := to_jsonb(appointment);
      WHEN 'waiting_appointment' THEN waiting_appointment_before := to_jsonb(appointment);
    END CASE;
  END LOOP;

  SELECT p.* INTO rx FROM public.prescriptions AS p
  WHERE p.id = (cfg->>'prescription')::uuid;
  IF NOT FOUND OR rx.clinic_id <> fixture_clinic_id OR rx.visit_id <> completed_visit.id
     OR rx.patient_id <> completed_visit.patient_id
     OR rx.prescribing_doctor_id <> (cfg->>'doctor')::uuid THEN
    RAISE EXCEPTION 'FAIL: prescription must belong to the completed visit/patient and D1';
  END IF;
  SELECT i.* INTO inv FROM public.investigations AS i
  WHERE i.id = (cfg->>'investigation')::uuid;
  IF NOT FOUND OR inv.clinic_id <> fixture_clinic_id OR inv.visit_id <> completed_visit.id
     OR inv.patient_id <> completed_visit.patient_id
     OR inv.requesting_doctor_id <> (cfg->>'doctor')::uuid THEN
    RAISE EXCEPTION 'FAIL: investigation must belong to the completed visit/patient and D1';
  END IF;
  SELECT a.* INTO audit FROM public.audit_logs AS a WHERE a.id = (cfg->>'audit')::uuid;
  IF NOT FOUND OR audit.clinic_id IS DISTINCT FROM fixture_clinic_id
     OR (
       (audit.table_name = 'visits' AND audit.record_id IN (completed_visit.id, open_visit.id))
       OR (audit.table_name = 'prescriptions' AND audit.record_id = rx.id)
       OR (audit.table_name = 'investigations' AND audit.record_id = inv.id)
       OR (audit.table_name = 'appointments' AND audit.record_id IN (
         (cfg->>'completed_appointment')::uuid, (cfg->>'open_appointment')::uuid,
         (cfg->>'waiting_appointment')::uuid))
     ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: audit fixture must be a Clinic A event for these clinical fixtures';
  END IF;
  RAISE NOTICE 'PASS -- fixture configuration, roles, relationships and statuses validated; starting denial tests';

  -- Each BEGIN/EXCEPTION block is a subtransaction (implicit savepoint).
  -- ZT001 deliberately rolls back every successful statement BEFORE assessing it.
  -- Only 42501 is accepted as an explicit direct-table permission denial.
  FOREACH actor_key IN ARRAY ARRAY[
    'admin', 'doctor', 'wrong_doctor', 'receptionist', 'other_clinic', 'inactive'
  ] LOOP
    actor_id := (cfg->>actor_key)::uuid;
    PERFORM set_config('request.jwt.claims', jsonb_build_object(
      'sub', actor_id::text, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
    FOR test_case IN SELECT * FROM (VALUES
      ('completed visit update', format('UPDATE public.visits SET clinical_notes = %L WHERE id = %L::uuid',
        'M13.5A DENIAL TEST', completed_visit.id)),
      ('visit delete', format('DELETE FROM public.visits WHERE id = %L::uuid', completed_visit.id)),
      ('prescription update', format('UPDATE public.prescriptions SET instructions = %L WHERE id = %L::uuid',
        'M13.5A DENIAL TEST', rx.id)),
      ('prescription delete', format('DELETE FROM public.prescriptions WHERE id = %L::uuid', rx.id)),
      ('investigation clinical/identity update', format(
        'UPDATE public.investigations SET result = %L, notes = %L, investigation_type = %L, requesting_doctor_id = %L::uuid, visit_id = %L::uuid, patient_id = %L::uuid, clinic_id = %L::uuid WHERE id = %L::uuid',
        'M13.5A DENIAL TEST', 'M13.5A DENIAL TEST', 'M13.5A DENIAL TEST',
        cfg->>'wrong_doctor', open_visit.id, open_visit.patient_id, fixture_clinic_id, inv.id))
    ) AS cases(label, sql) LOOP
      affected := NULL;
      BEGIN
        EXECUTE test_case.sql;
        GET DIAGNOSTICS affected = ROW_COUNT;
        RAISE EXCEPTION USING ERRCODE = 'ZT001', MESSAGE = 'Rollback successful test statement';
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE, error_message = MESSAGE_TEXT;
        IF state = '42501' OR (state = 'ZT001' AND affected = 0) THEN
          denial_count := denial_count + 1;
          RAISE NOTICE 'PASS -- % denied [%]', test_case.label, actor_key;
        ELSE
          RAISE EXCEPTION 'FAIL/INCONCLUSIVE -- % [%]: SQLSTATE %, affected %, %',
            test_case.label, actor_key, state, affected, error_message;
        END IF;
      END;
    END LOOP;
  END LOOP;

  -- Test the strongest ordinary application role: active Clinic A admin.
  actor_id := (cfg->>'admin')::uuid;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
  FOR test_case IN SELECT * FROM (VALUES
    ('completed appointment reopening to in_progress', cfg->>'completed_appointment', 'in_progress'),
    ('completed appointment reopening to waiting', cfg->>'completed_appointment', 'waiting'),
    ('direct waiting to in_progress', cfg->>'waiting_appointment', 'in_progress'),
    ('direct waiting to completed', cfg->>'waiting_appointment', 'completed'),
    ('direct in_progress to completed', cfg->>'open_appointment', 'completed')
  ) AS cases(label, id, status) LOOP
    affected := NULL;
    BEGIN
      EXECUTE format('UPDATE public.appointments SET status = %L::public.appointment_status_enum WHERE id = %L::uuid',
        test_case.status, test_case.id);
      GET DIAGNOSTICS affected = ROW_COUNT;
      RAISE EXCEPTION USING ERRCODE = 'ZT001', MESSAGE = 'Rollback successful test statement';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE, error_message = MESSAGE_TEXT;
      IF state = '42501' OR (state = 'ZT001' AND affected = 0) THEN
        denial_count := denial_count + 1;
        RAISE NOTICE 'PASS -- % denied', test_case.label;
      ELSE
        RAISE EXCEPTION 'FAIL/INCONCLUSIVE -- %: SQLSTATE %, affected %, %',
          test_case.label, state, affected, error_message;
      END IF;
    END;
  END LOOP;

  FOREACH actor_key IN ARRAY ARRAY['receptionist', 'wrong_doctor', 'other_clinic', 'inactive'] LOOP
    actor_id := (cfg->>actor_key)::uuid;
    PERFORM set_config('request.jwt.claims', jsonb_build_object(
      'sub', actor_id::text, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
    expected_message := CASE WHEN actor_key = 'wrong_doctor'
      THEN 'Only the assigned doctor can edit this consultation'
      ELSE 'Only an active clinic administrator or assigned doctor can edit this consultation' END;
    BEGIN
      PERFORM public.save_consultation(open_visit.id, 'M13.5A DENIAL TEST',
        NULL, NULL, NULL, NULL, NULL, NULL::date, NULL);
      RAISE EXCEPTION USING ERRCODE = 'ZT001', MESSAGE = 'Unauthorized save returned successfully';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE, error_message = MESSAGE_TEXT;
      IF state = 'P0001' AND error_message = expected_message THEN
        denial_count := denial_count + 1;
        RAISE NOTICE 'PASS -- unauthorized save_consultation denied [%]', actor_key;
      ELSE
        RAISE EXCEPTION 'FAIL/INCONCLUSIVE -- unauthorized save [%]: SQLSTATE %, %',
          actor_key, state, error_message;
      END IF;
    END;
  END LOOP;

  actor_id := (cfg->>'admin')::uuid;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
  FOR test_case IN SELECT * FROM (VALUES
    ('audit update', format('UPDATE public.audit_logs SET action = %L WHERE id = %L::uuid',
      'M13.5A DENIAL TEST', audit.id)),
    ('audit delete', format('DELETE FROM public.audit_logs WHERE id = %L::uuid', audit.id)),
    ('audit insert', format(
      'INSERT INTO public.audit_logs (clinic_id, actor_user_id, table_name, record_id, action) VALUES (%L::uuid, %L::uuid, %L, %L::uuid, %L)',
      fixture_clinic_id, actor_id, 'visits', completed_visit.id, 'M13.5A DENIAL TEST'))
  ) AS cases(label, sql) LOOP
    affected := NULL;
    BEGIN
      EXECUTE test_case.sql;
      GET DIAGNOSTICS affected = ROW_COUNT;
      RAISE EXCEPTION USING ERRCODE = 'ZT001', MESSAGE = 'Rollback successful test statement';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE, error_message = MESSAGE_TEXT;
      IF state = '42501' OR (state = 'ZT001' AND affected = 0) THEN
        denial_count := denial_count + 1;
        RAISE NOTICE 'PASS -- % denied', test_case.label;
      ELSE
        RAISE EXCEPTION 'FAIL/INCONCLUSIVE -- %: SQLSTATE %, affected %, %',
          test_case.label, state, affected, error_message;
      END IF;
    END;
  END LOOP;

  -- Positive history reads and negative cross-clinic/inactive reads.
  FOREACH actor_key IN ARRAY ARRAY[
    'admin', 'doctor', 'wrong_doctor', 'receptionist', 'other_clinic', 'inactive'
  ] LOOP
    actor_id := (cfg->>actor_key)::uuid;
    PERFORM set_config('request.jwt.claims', jsonb_build_object(
      'sub', actor_id::text, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
    FOR test_case IN SELECT * FROM (VALUES
      ('visits', format('SELECT count(*) FROM public.visits WHERE id IN (%L::uuid, %L::uuid)',
        completed_visit.id, open_visit.id), 2),
      ('prescriptions', format('SELECT count(*) FROM public.prescriptions WHERE id = %L::uuid', rx.id), 1),
      ('investigations', format('SELECT count(*) FROM public.investigations WHERE id = %L::uuid', inv.id), 1),
      ('appointments', format('SELECT count(*) FROM public.appointments WHERE id IN (%L::uuid, %L::uuid, %L::uuid)',
        cfg->>'completed_appointment', cfg->>'waiting_appointment', cfg->>'open_appointment'), 3)
    ) AS cases(label, sql, visible_count) LOOP
      EXECUTE test_case.sql INTO affected;
      IF affected <> CASE WHEN actor_key IN ('other_clinic', 'inactive') THEN 0 ELSE test_case.visible_count END THEN
        RAISE EXCEPTION 'FAIL -- % read visibility [%]: got % row(s)', test_case.label, actor_key, affected;
      END IF;
      read_count := read_count + 1;
      RAISE NOTICE 'PASS -- % read visibility [%]: % row(s)', test_case.label, actor_key, affected;
    END LOOP;
    IF actor_key <> 'admin' THEN
      SELECT count(*) INTO affected FROM public.audit_logs AS a WHERE a.id = audit.id;
      IF affected <> 0 THEN
        RAISE EXCEPTION 'FAIL -- audit event visible to non-admin [%]', actor_key;
      END IF;
      read_count := read_count + 1;
      RAISE NOTICE 'PASS -- admin-only audit read enforced [%]', actor_key;
    END IF;
  END LOOP;

  -- Confirm original rows still exist and have exactly their original contents.
  actor_id := (cfg->>'admin')::uuid;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
  IF (SELECT to_jsonb(v) FROM public.visits AS v WHERE v.id = completed_visit.id) IS DISTINCT FROM to_jsonb(completed_visit)
     OR (SELECT to_jsonb(v) FROM public.visits AS v WHERE v.id = open_visit.id) IS DISTINCT FROM to_jsonb(open_visit)
     OR (SELECT to_jsonb(p) FROM public.prescriptions AS p WHERE p.id = rx.id) IS DISTINCT FROM to_jsonb(rx)
     OR (SELECT to_jsonb(i) FROM public.investigations AS i WHERE i.id = inv.id) IS DISTINCT FROM to_jsonb(inv)
     OR (SELECT to_jsonb(a) FROM public.appointments AS a WHERE a.id = (cfg->>'completed_appointment')::uuid) IS DISTINCT FROM completed_appointment_before
     OR (SELECT to_jsonb(a) FROM public.appointments AS a WHERE a.id = (cfg->>'waiting_appointment')::uuid) IS DISTINCT FROM waiting_appointment_before
     OR (SELECT to_jsonb(a) FROM public.appointments AS a WHERE a.id = (cfg->>'open_appointment')::uuid) IS DISTINCT FROM open_appointment_before
     OR (SELECT to_jsonb(a) FROM public.audit_logs AS a WHERE a.id = audit.id) IS DISTINCT FROM to_jsonb(audit) THEN
    RAISE EXCEPTION 'FAIL -- fixture contents changed during verification (or concurrent use); transaction must be rolled back';
  END IF;
  IF denial_count <> 42 OR read_count <> 29 THEN
    RAISE EXCEPTION 'FAIL -- incomplete verification: % denial tests, % read checks', denial_count, read_count;
  END IF;
  RAISE NOTICE 'PASS SUMMARY -- 42 denial tests; 29 read checks; fixture snapshots unchanged. Every successful mutation attempt was rolled back in its exception subtransaction. Final ROLLBACK follows.';
END;
$verification$;

-- Never replace this with COMMIT. Nothing in this file creates database objects.
-- Errors abort the outer transaction; successful execution also ends in rollback.
ROLLBACK;
