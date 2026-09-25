-- SmartDental HMIS - 0009: protect visit-owned clinical records
-- Keep receptionist access read-only and prevent additions to completed
-- appointment-linked visits. Existing manual visits remain supported.

BEGIN;

DROP POLICY IF EXISTS investigations_update ON public.investigations;
CREATE POLICY investigations_update
ON public.investigations
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = investigations.clinic_id
      AND membership.user_id = auth.uid()
      AND membership.role IN ('admin', 'doctor')
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    WHERE membership.clinic_id = investigations.clinic_id
      AND membership.user_id = auth.uid()
      AND membership.role IN ('admin', 'doctor')
  )
);

DROP POLICY IF EXISTS prescriptions_create ON public.prescriptions;
CREATE POLICY prescriptions_create
ON public.prescriptions
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    JOIN public.visits AS visit
      ON visit.id = prescriptions.visit_id
     AND visit.clinic_id = prescriptions.clinic_id
     AND visit.patient_id = prescriptions.patient_id
    LEFT JOIN public.appointments AS appointment
      ON appointment.id = visit.appointment_id
    WHERE membership.clinic_id = prescriptions.clinic_id
      AND membership.user_id = auth.uid()
      AND (
        membership.role = 'admin'
        OR (
          membership.role = 'doctor'
          AND prescriptions.prescribing_doctor_id = auth.uid()
          AND visit.doctor_id = auth.uid()
        )
      )
      AND (visit.appointment_id IS NULL OR appointment.status = 'in_progress')
  )
);

DROP POLICY IF EXISTS investigations_create ON public.investigations;
CREATE POLICY investigations_create
ON public.investigations
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    JOIN public.visits AS visit
      ON visit.id = investigations.visit_id
     AND visit.clinic_id = investigations.clinic_id
     AND visit.patient_id = investigations.patient_id
    LEFT JOIN public.appointments AS appointment
      ON appointment.id = visit.appointment_id
    WHERE membership.clinic_id = investigations.clinic_id
      AND membership.user_id = auth.uid()
      AND (
        membership.role = 'admin'
        OR (
          membership.role = 'doctor'
          AND investigations.requesting_doctor_id = auth.uid()
          AND visit.doctor_id = auth.uid()
        )
      )
      AND (visit.appointment_id IS NULL OR appointment.status = 'in_progress')
  )
);

COMMIT;
