-- Enable clinic-scoped, append-only audit events for supported mutations.
BEGIN;

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_admin_read ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_system_insert ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_no_update ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_no_delete ON public.audit_logs;
DROP POLICY IF EXISTS active_membership_required ON public.audit_logs;

CREATE POLICY audit_logs_admin_read
ON public.audit_logs
FOR SELECT
TO authenticated
USING (
  clinic_id IS NOT NULL
  AND public.is_clinic_member_as(
    clinic_id,
    'admin'::public.user_role_enum
  )
);

REVOKE ALL ON TABLE public.audit_logs
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.audit_logs TO authenticated;

CREATE INDEX IF NOT EXISTS idx_audit_logs_clinic_actor_created
  ON public.audit_logs (clinic_id, actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_clinic_action_created
  ON public.audit_logs (clinic_id, action, created_at DESC);

CREATE OR REPLACE FUNCTION public.capture_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  event_clinic_id uuid;
  event_record_id uuid;
  event_actor_id uuid := auth.uid();
  event_action text;
  event_metadata jsonb := '{}'::jsonb;
  changed_fields text[];
  invoice_currency text;
BEGIN
  IF TG_TABLE_NAME = 'clinics' THEN
    event_clinic_id := NEW.id;
    event_record_id := NEW.id;
    IF TG_OP = 'INSERT' THEN
      event_action := 'created';
    ELSIF OLD.currency IS DISTINCT FROM NEW.currency THEN
      event_action := 'currency_changed';
      event_metadata := jsonb_build_object(
        'old_currency', OLD.currency,
        'new_currency', NEW.currency
      );
    ELSE
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'patients' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    IF TG_OP = 'INSERT' THEN
      event_action := 'created';
    ELSE
      SELECT COALESCE(array_agg(fields.key ORDER BY fields.key), ARRAY[]::text[])
      INTO changed_fields
      FROM jsonb_each(to_jsonb(NEW)) AS fields(key, value)
      WHERE fields.key NOT IN ('created_at', 'updated_at')
        AND (to_jsonb(OLD) -> fields.key) IS DISTINCT FROM fields.value;
      IF cardinality(changed_fields) = 0 THEN
        RETURN NULL;
      END IF;
      event_action := 'updated';
      event_metadata := jsonb_build_object('changed_fields', to_jsonb(changed_fields));
    END IF;
  ELSIF TG_TABLE_NAME = 'appointments' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    IF TG_OP = 'INSERT' THEN
      event_action := 'created';
      event_metadata := jsonb_build_object('new_status', NEW.status);
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      event_action := 'status_changed';
      event_metadata := jsonb_build_object(
        'old_status', OLD.status,
        'new_status', NEW.status
      );
    ELSE
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'visits' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    IF TG_OP = 'INSERT' THEN
      event_action := 'created';
    ELSE
      SELECT COALESCE(array_agg(fields.key ORDER BY fields.key), ARRAY[]::text[])
      INTO changed_fields
      FROM jsonb_each(to_jsonb(NEW)) AS fields(key, value)
      WHERE fields.key NOT IN ('created_at', 'updated_at')
        AND (to_jsonb(OLD) -> fields.key) IS DISTINCT FROM fields.value;
      IF cardinality(changed_fields) = 0 THEN
        RETURN NULL;
      END IF;
      event_action := 'consultation_updated';
      event_metadata := jsonb_build_object('changed_fields', to_jsonb(changed_fields));
    END IF;
  ELSIF TG_TABLE_NAME = 'prescriptions' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    event_action := 'created';
  ELSIF TG_TABLE_NAME = 'investigations' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    event_action := 'created';
  ELSIF TG_TABLE_NAME = 'dental_chart_entries' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    event_action := 'created';
    event_metadata := jsonb_build_object(
      'tooth_number', NEW.tooth_number,
      'entry_type', NEW.entry_type,
      'surfaces', to_jsonb(NEW.surfaces)
    );
  ELSIF TG_TABLE_NAME = 'invoices' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    event_action := 'created';
    event_metadata := jsonb_build_object('amount', NEW.total, 'currency', NEW.currency);
  ELSIF TG_TABLE_NAME = 'payments' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.id;
    event_action := 'recorded';
    SELECT invoice.currency
    INTO invoice_currency
    FROM public.invoices AS invoice
    WHERE invoice.id = NEW.invoice_id;
    event_metadata := jsonb_build_object(
      'amount', NEW.amount,
      'currency', invoice_currency,
      'payment_method', NEW.payment_method
    );
  ELSIF TG_TABLE_NAME = 'clinic_memberships' THEN
    event_clinic_id := NEW.clinic_id;
    event_record_id := NEW.user_id;
    IF OLD.role IS DISTINCT FROM NEW.role
       AND OLD.is_active IS DISTINCT FROM NEW.is_active THEN
      event_action := 'staff_updated';
      event_metadata := jsonb_build_object(
        'old_role', OLD.role,
        'new_role', NEW.role,
        'old_is_active', OLD.is_active,
        'new_is_active', NEW.is_active
      );
    ELSIF OLD.role IS DISTINCT FROM NEW.role THEN
      event_action := 'role_changed';
      event_metadata := jsonb_build_object('old_role', OLD.role, 'new_role', NEW.role);
    ELSIF OLD.is_active IS DISTINCT FROM NEW.is_active THEN
      event_action := CASE WHEN NEW.is_active THEN 'activated' ELSE 'deactivated' END;
      event_metadata := jsonb_build_object(
        'old_is_active', OLD.is_active,
        'new_is_active', NEW.is_active
      );
    ELSE
      RETURN NULL;
    END IF;
    event_actor_id := auth.uid();
  ELSE
    RAISE EXCEPTION 'Unsupported audit trigger table: %', TG_TABLE_NAME;
  END IF;

  INSERT INTO public.audit_logs (
    clinic_id,
    actor_user_id,
    table_name,
    record_id,
    action,
    metadata
  )
  VALUES (
    event_clinic_id,
    event_actor_id,
    TG_TABLE_NAME,
    event_record_id,
    event_action,
    event_metadata
  );

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_audit_event() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS audit_clinics_changes ON public.clinics;
CREATE TRIGGER audit_clinics_changes
AFTER INSERT OR UPDATE ON public.clinics
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_event();

DROP TRIGGER IF EXISTS audit_patients_changes ON public.patients;
CREATE TRIGGER audit_patients_changes
AFTER INSERT OR UPDATE ON public.patients
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_event();

DROP TRIGGER IF EXISTS audit_appointments_changes ON public.appointments;
CREATE TRIGGER audit_appointments_changes
AFTER INSERT OR UPDATE ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_event();

DROP TRIGGER IF EXISTS audit_visits_changes ON public.visits;
CREATE TRIGGER audit_visits_changes
AFTER INSERT OR UPDATE ON public.visits
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_event();

DROP TRIGGER IF EXISTS audit_prescriptions_insert ON public.prescriptions;
CREATE TRIGGER audit_prescriptions_insert
AFTER INSERT ON public.prescriptions
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_event();

DROP TRIGGER IF EXISTS audit_investigations_insert ON public.investigations;
CREATE TRIGGER audit_investigations_insert
AFTER INSERT ON public.investigations
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_event();

DROP TRIGGER IF EXISTS audit_dental_chart_entries_insert ON public.dental_chart_entries;
CREATE TRIGGER audit_dental_chart_entries_insert
AFTER INSERT ON public.dental_chart_entries
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_event();

DROP TRIGGER IF EXISTS audit_invoices_insert ON public.invoices;
CREATE TRIGGER audit_invoices_insert
AFTER INSERT ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_event();

DROP TRIGGER IF EXISTS audit_payments_insert ON public.payments;
CREATE TRIGGER audit_payments_insert
AFTER INSERT ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_event();

DROP TRIGGER IF EXISTS audit_clinic_memberships_update ON public.clinic_memberships;
CREATE TRIGGER audit_clinic_memberships_update
AFTER UPDATE ON public.clinic_memberships
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_event();

DROP FUNCTION IF EXISTS public.provision_clinic_staff_membership(
  uuid, uuid, text, public.user_role_enum
);

CREATE OR REPLACE FUNCTION public.provision_clinic_staff_membership(
  p_clinic_id uuid,
  p_user_id uuid,
  p_display_name text,
  p_role public.user_role_enum,
  p_actor_user_id uuid
)
RETURNS public.clinic_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  target_auth_user_id uuid;
  actor_admin_id uuid;
  existing_membership_clinic_id uuid;
  created_membership public.clinic_memberships;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Trusted staff provisioning is required';
  END IF;
  IF p_clinic_id IS NULL OR p_user_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Clinic, Auth user, and verified actor IDs are required';
  END IF;
  IF p_role IS NULL OR p_role NOT IN (
    'admin'::public.user_role_enum,
    'doctor'::public.user_role_enum,
    'receptionist'::public.user_role_enum
  ) THEN
    RAISE EXCEPTION 'Only admin, doctor, and receptionist roles can be provisioned';
  END IF;

  PERFORM 1
  FROM public.clinics AS clinic
  WHERE clinic.id = p_clinic_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target clinic was not found';
  END IF;

  SELECT membership.user_id INTO actor_admin_id
  FROM public.clinic_memberships AS membership
  WHERE membership.clinic_id = p_clinic_id
    AND membership.user_id = p_actor_user_id
    AND membership.role = 'admin'::public.user_role_enum
    AND membership.is_active
  FOR SHARE;
  IF actor_admin_id IS NULL THEN
    RAISE EXCEPTION 'Verified actor must be an active administrator of the target clinic';
  END IF;

  SELECT auth_user.id INTO target_auth_user_id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR UPDATE;
  IF target_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'Target Auth user was not found';
  END IF;

  SELECT membership.clinic_id INTO existing_membership_clinic_id
  FROM public.clinic_memberships AS membership
  WHERE membership.user_id = p_user_id
    AND membership.clinic_id = p_clinic_id;
  IF existing_membership_clinic_id IS NOT NULL THEN
    RAISE EXCEPTION 'Target Auth user already has a membership in this clinic';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Target Auth user already belongs to another clinic';
  END IF;

  INSERT INTO public.profiles AS existing_profile (id, display_name)
  VALUES (p_user_id, NULLIF(btrim(p_display_name), ''))
  ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      updated_at = now()
  WHERE NULLIF(btrim(existing_profile.display_name), '') IS NULL
    AND EXCLUDED.display_name IS NOT NULL;

  INSERT INTO public.clinic_memberships (user_id, clinic_id, role, is_active)
  VALUES (p_user_id, p_clinic_id, p_role, true)
  RETURNING * INTO created_membership;

  INSERT INTO public.audit_logs (
    clinic_id, actor_user_id, table_name, record_id, action, metadata
  )
  VALUES (
    p_clinic_id,
    actor_admin_id,
    'clinic_memberships',
    p_user_id,
    'provisioned',
    jsonb_build_object('role', p_role, 'is_active', true)
  );

  RETURN created_membership;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_clinic_staff_membership(
  uuid, uuid, text, public.user_role_enum, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.provision_clinic_staff_membership(
  uuid, uuid, text, public.user_role_enum, uuid
) TO service_role;

COMMIT;