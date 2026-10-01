-- SmartDental HMIS - 0012: restrict invoice and payment reads to finance roles

BEGIN;

DROP POLICY IF EXISTS invoices_select ON public.invoices;
CREATE POLICY invoices_select
ON public.invoices
FOR SELECT
TO authenticated
USING (
  public.is_clinic_member_as(clinic_id, 'admin'::public.user_role_enum)
  OR public.is_clinic_member_as(clinic_id, 'receptionist'::public.user_role_enum)
);

DROP POLICY IF EXISTS payments_select ON public.payments;
CREATE POLICY payments_select
ON public.payments
FOR SELECT
TO authenticated
USING (
  public.is_clinic_member_as(clinic_id, 'admin'::public.user_role_enum)
  OR public.is_clinic_member_as(clinic_id, 'receptionist'::public.user_role_enum)
);

COMMIT;