-- Reject nonfinite billing amounts without changing finite-value precision,
-- authorization, accounting, or clinical lifecycle behavior.
BEGIN;

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

COMMIT;
