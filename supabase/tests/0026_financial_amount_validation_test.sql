-- DEVELOPMENT ONLY: qsxqmtmmzevunojzgjnt. NEVER Production rehaibsmdghrodjeqron.
-- NOT EXECUTED. Run the ENTIRE file in ONE SQL Editor Run as postgres,
-- with no existing transaction. Never run selected fragments or assume that
-- separate Run actions share a session. Manually verify the Dashboard project.
-- Set the project confirmation and THREE distinct existing, explicitly authorized
-- synthetic test Auth UUIDs below; each must already have a public.profiles row.
-- Roles are assigned only in new rollback-only clinics. The denial identity is
-- reused for doctor, inactive-admin, other-clinic-admin, and patient-role scenarios.
-- No Auth accounts, real patients, existing memberships, or profiles are modified.
-- No pre-transaction writes. Function snapshots live in PL/pgSQL variables.
-- No test helper functions, temporary tables, or additional grants are created.
-- An enclosing exception subtransaction rolls back ALL function replacements and
-- fixtures on success OR unexpected error, before catalog restoration is checked.
-- Compatibility: SET ROLE is prohibited in SECURITY DEFINER functions, not in
-- this ordinary invoker DO block. Role changes occur outside the inner expected
-- RPC-error blocks. Corruption rollback blocks intentionally contain role changes.
-- Sources: https://www.postgresql.org/docs/current/sql-set-role.html
--          https://www.postgresql.org/docs/current/plpgsql-control-structures.html
-- No COMMIT/ROLLBACK/SAVEPOINT commands are executed inside the DO block.
-- Cancellation/assertion errors are caught for cleanup/reporting, then re-raised.
-- Backend termination/disconnection aborts the transaction; external trigger side
-- effects, if any, are not undoable. Review Development integrations beforehand.
-- Final ROLLBACK is unconditional when reached. If the runner stops on an error,
-- this transaction is aborted: roll back in the SAME session or close it.
-- Only the verified PASS result row establishes tests AND restoration passed.
-- 0025 is neither applied nor repaired; no migration history is written.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $harness$
DECLARE
  cfg record;
  ids uuid[];
  item uuid;
  original_functions jsonb;
  restored_functions jsonb;
  test_completed boolean:=false;
  failure_state text;
  failure_message text;
BEGIN
  -- Transaction-local result flag: never reuse a previous successful run.
  PERFORM set_config('ss0026.test_outcome','PENDING',true);
  IF current_user<>'postgres' OR session_user<>'postgres' THEN
    RAISE EXCEPTION 'STOP: postgres session/setup role required'; END IF;
  SELECT
    'qsxqmtmmzevunojzgjnt'::text AS confirmed_project_ref,
'96c374e9-c0da-4550-86b9-bb851aa6422c'::text AS admin_id,
'8f5cc47e-26a6-4c65-a854-445f6b3fc537'::text AS receptionist_id,
'a5fed722-6d43-473d-9ef3-807e16e06845'::text AS denial_id
  INTO cfg;
  IF cfg.confirmed_project_ref<>'qsxqmtmmzevunojzgjnt' THEN
    RAISE EXCEPTION 'STOP: manually confirm Development and replace project confirmation'; END IF;
  ids:=ARRAY[cfg.admin_id::uuid,cfg.receptionist_id::uuid,cfg.denial_id::uuid];
  IF (SELECT count(DISTINCT x) FROM unnest(ids) x)<>3 THEN
    RAISE EXCEPTION 'STOP: three distinct authorized test identities required'; END IF;
  FOREACH item IN ARRAY ids LOOP
    IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=item)
      OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=item) THEN
      RAISE EXCEPTION 'STOP: configured test identity/profile unavailable'; END IF;
  END LOOP;
  -- Migration history is unavailable in Development. Do not infer migration
  -- completeness from table existence. The exact RPC baseline checks below
  -- remain mandatory; missing/incompatible fixture dependencies fail closed
  -- during this rollback-only rehearsal. No migration status is asserted.
  SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'metadata',to_jsonb(p),
    'definition',pg_get_functiondef(p.oid)) ORDER BY p.oid) INTO original_functions
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
    AND p.proname IN ('create_invoice','record_payment');
  IF jsonb_array_length(original_functions) IS DISTINCT FROM 2
    OR to_regprocedure('public.create_invoice(uuid,uuid,uuid,numeric)') IS NULL
    OR to_regprocedure('public.record_payment(uuid,numeric,public.payment_method_enum,text)') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected exactly two baseline signatures'; END IF;
  IF (SELECT replace(p.prosrc, E'\r\n', E'\n') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_invoice' AND p.prokind='f') IS DISTINCT FROM replace($expected$
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
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
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
$expected$, E'\r\n', E'\n') THEN
    RAISE EXCEPTION 'STOP: create_invoice differs from migration 0013 baseline';
  END IF;
  IF (SELECT replace(p.prosrc, E'\r\n', E'\n') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='record_payment' AND p.prokind='f') IS DISTINCT FROM replace($expected$
DECLARE
  current_user_id uuid := auth.uid();
  invoice_row public.invoices;
  caller_role public.user_role_enum;
  new_amount_paid numeric;
  created_payment public.payments;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
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
$expected$, E'\r\n', E'\n') THEN
    RAISE EXCEPTION 'STOP: record_payment differs from migration 0013 baseline';
  END IF;

  -- Everything mutable is inside this forced-rollback subtransaction.
  BEGIN
    -- Fail before function replacement/fixture creation if this execution context
    -- cannot change roles (e.g. invoked through a SECURITY DEFINER wrapper).
    -- A plain SQL Editor postgres session must support this exact round trip.
    EXECUTE 'SET LOCAL ROLE authenticated';
    IF current_user<>'authenticated' THEN RAISE EXCEPTION 'STOP: SET ROLE unavailable'; END IF;
    EXECUTE 'RESET ROLE';
    IF current_user<>'postgres' THEN RAISE EXCEPTION 'STOP: RESET ROLE did not restore postgres'; END IF;
    EXECUTE $install_create_invoice$
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
$install_create_invoice$;
    EXECUTE $install_record_payment$
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
$install_record_payment$;
DECLARE
  admin_id uuid; receptionist_id uuid;
  other_id uuid; affected bigint;
  clinic_a uuid:=gen_random_uuid(); clinic_b uuid:=gen_random_uuid();
  patient_a uuid:=gen_random_uuid(); invoice_id uuid; inv public.invoices;
  pay public.payments; c record; actor uuid; value numeric; column_name text;
  payment_count bigint; before_state jsonb; after_state jsonb;
  expected_message text; caught_message text; denied integer:=0;
BEGIN
  admin_id:=cfg.admin_id::uuid; receptionist_id:=cfg.receptionist_id::uuid;
  other_id:=cfg.denial_id::uuid;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  INSERT INTO public.clinics(id,name,currency)
    VALUES(clinic_a,'SYNTHETIC SS0026 A','USD'),(clinic_b,'SYNTHETIC SS0026 B','USD');
  INSERT INTO public.clinic_memberships(user_id,clinic_id,role,is_active) VALUES
    (admin_id,clinic_a,'admin',true),(receptionist_id,clinic_a,'receptionist',true),
    (other_id,clinic_b,'admin',true);
  INSERT INTO public.patients(id,clinic_id,patient_number,first_name,last_name)
    VALUES(patient_a,clinic_a,'SERVER_ASSIGNED','SYNTHETIC','SS0026 ONLY');

  -- NULL visit is an existing supported RPC path. This harness tests billing,
  -- not completion/finalization; no real or pre-existing clinical rows are used.
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF current_user<>'authenticated' OR auth.uid() IS DISTINCT FROM admin_id THEN
    RAISE EXCEPTION 'FAIL: authenticated identity simulation failed';
  END IF;
  inv:=public.create_invoice(clinic_a,patient_a,NULL,10.1234);
  IF inv.clinic_id<>clinic_a OR inv.patient_id<>patient_a OR inv.total<>10.1234
    OR inv.subtotal<>10.1234 OR inv.discount<>0 OR inv.amount_paid<>0
    OR inv.balance<>10.1234 OR inv.status<>'draft' OR inv.currency<>'USD'
    OR inv.invoice_number<>'INV-000001' THEN RAISE EXCEPTION 'FAIL: finite invoice'; END IF;
  pay:=public.record_payment(inv.id,0.1234,'cash','SYNTHETIC');
  IF pay.amount<>0.1234 OR pay.recorded_by<>admin_id THEN RAISE EXCEPTION 'FAIL: first payment'; END IF;
  SELECT * INTO STRICT inv FROM public.invoices WHERE id=inv.id;
  IF inv.balance<>10 OR inv.amount_paid<>0.1234 OR inv.status<>'partially_paid' THEN
    RAISE EXCEPTION 'FAIL: partial accounting/precision'; END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',receptionist_id,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',receptionist_id::text,true);
  IF current_user<>'authenticated' OR auth.uid() IS DISTINCT FROM receptionist_id THEN
    RAISE EXCEPTION 'FAIL: receptionist role simulation'; END IF;
  pay:=public.record_payment(inv.id,10,'cash',NULL);
  SELECT * INTO STRICT inv FROM public.invoices WHERE id=inv.id;
  IF inv.balance<>0 OR inv.amount_paid<>10.1234 OR inv.status<>'paid'
    OR pay.recorded_by<>receptionist_id THEN RAISE EXCEPTION 'FAIL: final payment'; END IF;
  inv:=public.create_invoice(clinic_a,patient_a,NULL,100);
  invoice_id:=inv.id;
  IF inv.total<>100 OR inv.invoice_number<>'INV-000002' THEN
    RAISE EXCEPTION 'FAIL: receptionist invoice/numbering'; END IF;
  EXECUTE 'RESET ROLE';

  -- Snapshot ONLY the new synthetic tenant. Includes counters and audit rows.
  SELECT jsonb_build_object(
    'invoices',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.invoices x WHERE clinic_id=clinic_a),
    'payments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.payments x WHERE clinic_id=clinic_a),
    'counter',(SELECT to_jsonb(x) FROM public.clinic_invoice_sequences x WHERE clinic_id=clinic_a),
    'audit',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.audit_logs x WHERE clinic_id=clinic_a AND table_name IN ('invoices','payments'))
  ) INTO before_state;

  FOR c IN
    SELECT kind,amount,expected FROM (VALUES
      ('invoice','NaN'::numeric,'Invoice total must be finite'),
      ('invoice','Infinity'::numeric,'Invoice total must be finite'),
      ('invoice','-Infinity'::numeric,'Invoice total must be finite'),
      ('invoice',NULL::numeric,'Invoice total must be greater than zero'),
      ('invoice',0::numeric,'Invoice total must be greater than zero'),
      ('invoice',(-1)::numeric,'Invoice total must be greater than zero'),
      ('payment','NaN'::numeric,'Payment amount must be finite'),
      ('payment','Infinity'::numeric,'Payment amount must be finite'),
      ('payment','-Infinity'::numeric,'Payment amount must be finite'),
      ('payment',NULL::numeric,'Payment amount must be greater than zero'),
      ('payment',0::numeric,'Payment amount must be greater than zero'),
      ('payment',(-1)::numeric,'Payment amount must be greater than zero'),
      ('payment',101::numeric,'Payment exceeds the remaining invoice balance')
    ) cases(kind,amount,expected)
  LOOP
    EXECUTE 'SET LOCAL ROLE authenticated';
    IF current_user<>'authenticated' OR auth.uid() IS DISTINCT FROM receptionist_id THEN
      RAISE EXCEPTION 'FAIL: invalid-input role simulation'; END IF;
    BEGIN
      IF c.kind='invoice' THEN PERFORM public.create_invoice(clinic_a,patient_a,NULL,c.amount);
      ELSE PERFORM public.record_payment(invoice_id,c.amount,'cash',NULL); END IF;
      RAISE EXCEPTION USING ERRCODE='ZT026',MESSAGE='FAIL: invalid amount accepted';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      GET STACKED DIAGNOSTICS caught_message=MESSAGE_TEXT;
      IF caught_message<>c.expected THEN RAISE EXCEPTION 'FAIL: unexpected rejection: %',caught_message; END IF;
      denied:=denied+1;
    END;
    EXECUTE 'RESET ROLE';
  END LOOP;

  -- Finite inputs ensure authorization tests do not merely hit numeric guards.
  -- One denial identity is reused in four scenarios. Only its NEW synthetic
  -- memberships change; pre-existing memberships/profiles/Auth users are untouched.
  FOR c IN SELECT * FROM (VALUES ('doctor'),('inactive'),('other_clinic'),('patient')) scenarios(mode) LOOP
    actor:=cfg.denial_id::uuid;
    DELETE FROM public.clinic_memberships WHERE clinic_id=clinic_a AND user_id=actor;
    IF c.mode<>'other_clinic' THEN
      INSERT INTO public.clinic_memberships(user_id,clinic_id,role,is_active)
      VALUES(actor,clinic_a,
        CASE c.mode WHEN 'doctor' THEN 'doctor'::public.user_role_enum
          WHEN 'patient' THEN 'patient'::public.user_role_enum ELSE 'admin'::public.user_role_enum END,
        c.mode<>'inactive');
    END IF;
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
    PERFORM set_config('request.jwt.claim.sub',actor::text,true);
    FOREACH expected_message IN ARRAY ARRAY[
      'Only an active administrator or receptionist can create invoices',
      'Only an active administrator or receptionist can record payments'] LOOP
      EXECUTE 'SET LOCAL ROLE authenticated';
      IF current_user<>'authenticated' OR auth.uid() IS DISTINCT FROM actor OR auth.role()<>'authenticated' THEN
        RAISE EXCEPTION 'FAIL: wrong simulated authorization role/actor'; END IF;
      BEGIN
        IF expected_message LIKE '%create invoices' THEN
          PERFORM public.create_invoice(clinic_a,patient_a,NULL,1);
        ELSE PERFORM public.record_payment(invoice_id,1,'cash',NULL); END IF;
        RAISE EXCEPTION USING ERRCODE='ZT026',MESSAGE='FAIL: unauthorized RPC succeeded';
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        GET STACKED DIAGNOSTICS caught_message=MESSAGE_TEXT;
        IF caught_message<>expected_message THEN RAISE EXCEPTION 'FAIL: wrong authorization error: %',caught_message; END IF;
        denied:=denied+1;
      END;
      EXECUTE 'RESET ROLE';
      IF current_user<>'postgres' THEN RAISE EXCEPTION 'FAIL: setup role not restored'; END IF;
    END LOOP;
  END LOOP;
  -- Ordinary invoker DO permits SET ROLE. Each outer per-case exception block
  -- rolls back BOTH the privileged synthetic UPDATE and any role changes. The
  -- role is established before the inner expected-RPC-error block; no helper,
  -- schema grants, disabled triggers, or bypass of the RPC role check is needed.
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
  FOREACH column_name IN ARRAY ARRAY['subtotal','discount','total','amount_paid','balance'] LOOP
    FOREACH value IN ARRAY ARRAY['NaN'::numeric,'Infinity'::numeric] LOOP
      IF current_user<>'postgres' THEN RAISE EXCEPTION 'FAIL: corruption setup role'; END IF;
      BEGIN
        EXECUTE format('UPDATE public.invoices SET %I=$1 WHERE id=$2 AND clinic_id=$3',column_name)
          USING value,invoice_id,clinic_a;
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected<>1 THEN RAISE EXCEPTION 'FAIL: synthetic corruption target unavailable'; END IF;
        EXECUTE 'SET LOCAL ROLE authenticated';
        IF current_user<>'authenticated' OR auth.uid() IS DISTINCT FROM admin_id
          OR auth.role()<>'authenticated' THEN
          RAISE EXCEPTION 'FAIL: stored-value role simulation'; END IF;
        BEGIN
          PERFORM public.record_payment(invoice_id,1,'cash',NULL);
          RAISE EXCEPTION USING ERRCODE='ZT026',MESSAGE='FAIL: corrupted invoice accepted';
        EXCEPTION WHEN SQLSTATE 'P0001' THEN
          GET STACKED DIAGNOSTICS caught_message=MESSAGE_TEXT;
          IF caught_message<>'Invoice financial amounts must be finite before recording payment' THEN
            RAISE EXCEPTION 'FAIL: wrong stored-value rejection: %',caught_message; END IF;
        END;
        EXECUTE 'RESET ROLE';
        IF current_user<>'postgres' THEN RAISE EXCEPTION 'FAIL: setup role not restored'; END IF;
        RAISE EXCEPTION USING ERRCODE='ZT027',MESSAGE='Rollback synthetic corruption';
      EXCEPTION WHEN SQLSTATE 'ZT027' THEN denied:=denied+1;
      END;
      -- SET/RESET above are also unwound by the per-case rollback.
      IF current_user<>'postgres' THEN RAISE EXCEPTION 'FAIL: role not restored after case rollback'; END IF;
    END LOOP;
  END LOOP;
  SELECT jsonb_build_object(
    'invoices',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.invoices x WHERE clinic_id=clinic_a),
    'payments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.payments x WHERE clinic_id=clinic_a),
    'counter',(SELECT to_jsonb(x) FROM public.clinic_invoice_sequences x WHERE clinic_id=clinic_a),
    'audit',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.audit_logs x WHERE clinic_id=clinic_a AND table_name IN ('invoices','payments'))
  ) INTO after_state;
  IF after_state IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'FAIL: rejected calls changed synthetic state'; END IF;
  SELECT count(*) INTO payment_count FROM public.payments WHERE clinic_id=clinic_a;
  IF payment_count<>2 OR denied<>31 THEN RAISE EXCEPTION 'FAIL: incomplete test execution'; END IF;
  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(original_functions) b
    LEFT JOIN pg_proc p ON p.oid=(b->>'oid')::oid
    WHERE p.oid IS NULL OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM ((b->'metadata')-'prosrc')
  ) THEN RAISE EXCEPTION 'FAIL: replacement changed non-body function metadata'; END IF;
  RAISE NOTICE 'Tests completed: valid billing and 31 denials. Restoration verification pending.';
END;
    test_completed:=true;
    -- Variables survive an exception; all database/session changes in this
    -- subtransaction (including SET LOCAL ROLE and JWT claims) are rolled back.
    RAISE EXCEPTION USING ERRCODE='ZT028',MESSAGE='SS0026 successful rehearsal rollback';
  EXCEPTION
    WHEN SQLSTATE 'ZT028' THEN
      IF NOT test_completed THEN
        failure_state:='ZT028'; failure_message:='Unexpected rollback sentinel';
      END IF;
    WHEN query_canceled OR assert_failure OR OTHERS THEN
      GET STACKED DIAGNOSTICS failure_state=RETURNED_SQLSTATE,failure_message=MESSAGE_TEXT;
  END;

  IF current_user<>'postgres' THEN RAISE EXCEPTION 'FAIL: role not restored after cleanup'; END IF;
  SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'metadata',to_jsonb(p),
    'definition',pg_get_functiondef(p.oid)) ORDER BY p.oid) INTO restored_functions
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
    AND p.proname IN ('create_invoice','record_payment');
  IF restored_functions IS DISTINCT FROM original_functions THEN
    RAISE EXCEPTION 'FAIL: original function definitions/catalog metadata not restored'; END IF;
  IF failure_state IS NOT NULL OR NOT test_completed THEN
    RAISE EXCEPTION USING ERRCODE=COALESCE(failure_state,'ZT026'),
      MESSAGE='SS0026 FAILED; changes rolled back and original functions verified restored. '||COALESCE(failure_message,'Tests incomplete');
  END IF;
  -- Reached only after every test and exact restoration assertion succeeded.
  PERFORM set_config('ss0026.test_outcome','PASS',true);
  RAISE NOTICE 'PASS: valid billing tests and all 31 rejection tests passed; all rehearsal changes rolled back; exact original definitions and catalog metadata restored. Final outer ROLLBACK follows.';
END;
$harness$;

-- Visible result after the rehearsal subtransaction has ALREADY rolled back and
-- exact original definitions/metadata have been verified. Keep this SELECT and
-- the final ROLLBACK in the SAME Run. Failure aborts the transaction before this
-- SELECT can return PASS. The result flag is discarded by the outer ROLLBACK.
SELECT current_setting('ss0026.test_outcome') AS test_result,
       31 AS rejection_tests_passed,
       'Valid billing passed; rehearsal changes rolled back; original functions and metadata restored'::text AS verification
WHERE current_setting('ss0026.test_outcome') = 'PASS';

-- Never replace with COMMIT. No definitions, fixtures or history are persisted.
ROLLBACK;
