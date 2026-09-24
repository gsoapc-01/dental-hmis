-- SmartDental HMIS - 0005: optional approximate patient age
-- Exact date of birth and approximate age remain distinct values.

BEGIN;

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS approximate_age_years integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'patients_approximate_age_nonnegative'
      AND conrelid = 'public.patients'::regclass
  ) THEN
    ALTER TABLE public.patients
      ADD CONSTRAINT patients_approximate_age_nonnegative
      CHECK (approximate_age_years IS NULL OR approximate_age_years >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'patients_dob_age_exclusive'
      AND conrelid = 'public.patients'::regclass
  ) THEN
    ALTER TABLE public.patients
      ADD CONSTRAINT patients_dob_age_exclusive
      CHECK (date_of_birth IS NULL OR approximate_age_years IS NULL);
  END IF;
END;
$$;

COMMIT;
