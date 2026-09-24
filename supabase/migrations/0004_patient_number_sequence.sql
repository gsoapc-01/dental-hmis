-- SmartDental HMIS - 0004: concurrency-safe per-clinic patient file numbers
-- Existing patient numbers are preserved. New inserts receive the next number.

BEGIN;

CREATE TABLE IF NOT EXISTS public.patient_number_sequences (
  clinic_id uuid PRIMARY KEY REFERENCES public.clinics(id) ON DELETE CASCADE,
  next_number bigint NOT NULL CHECK (next_number > 0)
);

-- Seed each clinic after existing numeric patient numbers so the first generated
-- number cannot collide with data created before this migration.
INSERT INTO public.patient_number_sequences (clinic_id, next_number)
SELECT
  p.clinic_id,
  GREATEST(
    COALESCE(MAX(CASE WHEN p.patient_number ~ '^[0-9]+$' THEN p.patient_number::bigint ELSE 0 END), 0) + 1,
    1
  )
FROM public.patients AS p
GROUP BY p.clinic_id
ON CONFLICT (clinic_id) DO NOTHING;

ALTER TABLE public.patient_number_sequences ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.assign_patient_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  allocated_number bigint;
BEGIN
  INSERT INTO public.patient_number_sequences (clinic_id, next_number)
  VALUES (NEW.clinic_id, 2)
  ON CONFLICT (clinic_id) DO UPDATE
    SET next_number = public.patient_number_sequences.next_number + 1
  RETURNING next_number - 1 INTO allocated_number;

  NEW.patient_number := lpad(allocated_number::text, 3, '0');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_patient_number() FROM PUBLIC;

DROP TRIGGER IF EXISTS patients_assign_patient_number ON public.patients;
CREATE TRIGGER patients_assign_patient_number
  BEFORE INSERT ON public.patients
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_patient_number();

REVOKE ALL ON TABLE public.patient_number_sequences FROM PUBLIC, anon, authenticated;

COMMIT;
