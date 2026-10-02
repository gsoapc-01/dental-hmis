-- Restrict future clinic currency values while allowing existing legacy rows
-- to remain untouched until an administrator selects a supported currency.
BEGIN;

ALTER TABLE public.clinics
  ADD CONSTRAINT clinics_currency_supported_check
  CHECK (currency IN ('TZS', 'KES', 'UGX', 'USD'))
  NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.clinics
    WHERE currency NOT IN ('TZS', 'KES', 'UGX', 'USD')
  ) THEN
    ALTER TABLE public.clinics
      VALIDATE CONSTRAINT clinics_currency_supported_check;
  END IF;
END;
$$;

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

REVOKE ALL ON FUNCTION public.update_clinic_currency(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_clinic_currency(uuid, text)
  TO authenticated;

COMMIT;