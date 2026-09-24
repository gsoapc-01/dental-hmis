-- SmartDental HMIS - 0007: staff access to the clinic doctor directory
-- Appointment booking needs doctor choices, but no staff member should see
-- memberships or profiles outside their current clinic.

BEGIN;

DROP POLICY IF EXISTS memberships_staff_doctor_read
ON public.clinic_memberships;

CREATE POLICY memberships_staff_doctor_read
ON public.clinic_memberships
FOR SELECT
TO authenticated
USING (
  role = 'doctor'
  AND public.is_clinic_staff(clinic_id)
);

DROP POLICY IF EXISTS profiles_staff_doctor_read
ON public.profiles;

CREATE POLICY profiles_staff_doctor_read
ON public.profiles
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.user_id = profiles.id
      AND membership.role = 'doctor'
      AND public.is_clinic_staff(membership.clinic_id)
  )
);

COMMIT;
