-- SmartDental HMIS - 0006: reconcile patient file-number sequences
-- 0004 seeded counters once; this migration repairs counters that drifted
-- behind existing numeric patient records and hardens future allocations.

BEGIN;

-- Advance every existing clinic counter beyond its highest numeric patient file.
INSERT INTO public.patient_number_sequences (clinic_id, next_number)
SELECT
  p.clinic_id,
  COALESCE(MAX(CASE WHEN p.patient_number ~ '^[0-9]+$' THEN p.patient_number::bigint ELSE 0 END), 0) + 1
FROM public.patients AS p
GROUP BY p.clinic_id
ON CONFLICT (clinic_id) DO UPDATE
  SET next_number = GREATEST(
    public.patient_number_sequences.next_number,
    EXCLUDED.next_number
  );

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

  NEW.patient_number := lpad(allocated_number::text, 3, '0');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_patient_number() FROM PUBLIC;

COMMIT;
