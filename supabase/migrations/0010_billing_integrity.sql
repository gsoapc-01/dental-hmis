-- SmartDental HMIS - 0010: atomic invoices, payments, and receipts foundation
-- Allocates clinic-scoped invoice numbers and keeps payment accounting atomic.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payments WHERE amount <= 0) THEN
    RAISE EXCEPTION 'Cannot require positive payments: non-positive payment rows already exist';
  END IF;
END;
$$;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_amount_positive;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_amount_positive CHECK (amount > 0);

CREATE TABLE IF NOT EXISTS public.clinic_invoice_sequences (
  clinic_id uuid PRIMARY KEY REFERENCES public.clinics(id) ON DELETE RESTRICT,
  next_invoice_number bigint NOT NULL CHECK (next_invoice_number > 0)
);

ALTER TABLE public.clinic_invoice_sequences ENABLE ROW LEVEL SECURITY;

INSERT INTO public.clinic_invoice_sequences (clinic_id, next_invoice_number)
SELECT clinic.id,
       COALESCE(MAX((substring(invoice.invoice_number FROM '^INV-([0-9]+)$'))::bigint), 0) + 1
FROM public.clinics AS clinic
LEFT JOIN public.invoices AS invoice ON invoice.clinic_id = clinic.id
GROUP BY clinic.id
ON CONFLICT (clinic_id) DO NOTHING;

DROP POLICY IF EXISTS invoices_staff_update ON public.invoices;
CREATE POLICY invoices_no_direct_update
ON public.invoices
FOR UPDATE
TO authenticated
USING (false)
WITH CHECK (false);

DROP POLICY IF EXISTS invoices_staff_insert ON public.invoices;
CREATE POLICY invoices_no_direct_insert
ON public.invoices
FOR INSERT
TO authenticated
WITH CHECK (false);

DROP POLICY IF EXISTS invoices_admin_delete ON public.invoices;
CREATE POLICY invoices_no_direct_delete
ON public.invoices
FOR DELETE
TO authenticated
USING (false);

DROP POLICY IF EXISTS payments_staff_insert ON public.payments;
CREATE POLICY payments_no_direct_insert
ON public.payments
FOR INSERT
TO authenticated
WITH CHECK (false);

DROP POLICY IF EXISTS payments_admin_update ON public.payments;
CREATE POLICY payments_no_direct_update
ON public.payments
FOR UPDATE
TO authenticated
USING (false)
WITH CHECK (false);

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

  IF p_total IS NULL OR p_total <= 0 THEN
    RAISE EXCEPTION 'Invoice total must be greater than zero';
  END IF;

  SELECT membership.role INTO caller_role
  FROM public.clinic_memberships AS membership
  WHERE membership.clinic_id = p_clinic_id
    AND membership.user_id = current_user_id;

  IF caller_role IS NULL OR caller_role NOT IN ('admin', 'receptionist') THEN
    RAISE EXCEPTION 'Only an administrator or receptionist can create invoices';
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
    clinic_id,
    patient_id,
    visit_id,
    invoice_number,
    status,
    subtotal,
    discount,
    total,
    amount_paid,
    balance,
    currency
  )
  VALUES (
    p_clinic_id,
    p_patient_id,
    p_visit_id,
    'INV-' || lpad(allocated_number::text, 6, '0'),
    'draft',
    p_total,
    0,
    p_total,
    0,
    p_total,
    clinic_currency
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
    AND membership.user_id = current_user_id;

  IF caller_role IS NULL OR caller_role NOT IN ('admin', 'receptionist') THEN
    RAISE EXCEPTION 'Only an administrator or receptionist can record payments';
  END IF;

  IF invoice_row.status IN ('cancelled', 'void', 'paid') THEN
    RAISE EXCEPTION 'This invoice cannot accept another payment';
  END IF;

  IF p_amount > invoice_row.balance THEN
    RAISE EXCEPTION 'Payment exceeds the remaining invoice balance';
  END IF;

  new_amount_paid := invoice_row.amount_paid + p_amount;

  INSERT INTO public.payments (
    clinic_id,
    invoice_id,
    patient_id,
    recorded_by,
    payment_method,
    amount,
    reference
  )
  VALUES (
    invoice_row.clinic_id,
    invoice_row.id,
    invoice_row.patient_id,
    current_user_id,
    p_payment_method,
    p_amount,
    NULLIF(btrim(p_reference), '')
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

REVOKE ALL ON FUNCTION public.create_invoice(uuid, uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_payment(uuid, numeric, public.payment_method_enum, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_invoice(uuid, uuid, uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment(uuid, numeric, public.payment_method_enum, text) TO authenticated;

COMMIT;
