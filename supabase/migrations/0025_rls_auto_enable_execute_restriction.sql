-- Record the client EXECUTE restriction already applied in Production.
-- PUBLIC must be included because functions receive PUBLIC EXECUTE by default.
-- Keep the function, its owner, and ensure_rls event-trigger behavior unchanged.
BEGIN;

DO $$
BEGIN
  -- Some environments do not have this optional event-trigger function.
  IF pg_catalog.to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
  END IF;
END;
$$;

COMMIT;
