-- SmartDental HMIS - 0011: append-only visit-based dental chart entries

BEGIN;

CREATE TABLE public.dental_chart_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  tooth_number smallint NOT NULL,
  surfaces text[] NOT NULL DEFAULT '{}',
  entry_type text NOT NULL,
  finding text,
  procedure_text text,
  notes text,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dental_chart_entries_tooth_fdi_check CHECK (
    tooth_number BETWEEN 11 AND 18
    OR tooth_number BETWEEN 21 AND 28
    OR tooth_number BETWEEN 31 AND 38
    OR tooth_number BETWEEN 41 AND 48
    OR tooth_number BETWEEN 51 AND 55
    OR tooth_number BETWEEN 61 AND 65
    OR tooth_number BETWEEN 71 AND 75
    OR tooth_number BETWEEN 81 AND 85
  ),
  CONSTRAINT dental_chart_entries_surfaces_check CHECK (
    cardinality(surfaces) <= 6
    AND surfaces <@ ARRAY[
      'mesial',
      'distal',
      'buccal_facial',
      'lingual_palatal',
      'occlusal',
      'incisal'
    ]::text[]
  ),
  CONSTRAINT dental_chart_entries_type_check CHECK (
    entry_type IN ('finding', 'procedure', 'finding_and_procedure')
  ),
  CONSTRAINT dental_chart_entries_meaningful_check CHECK (
    (
      entry_type = 'finding'
      AND NULLIF(btrim(finding), '') IS NOT NULL
      AND NULLIF(btrim(procedure_text), '') IS NULL
    )
    OR (
      entry_type = 'procedure'
      AND NULLIF(btrim(finding), '') IS NULL
      AND NULLIF(btrim(procedure_text), '') IS NOT NULL
    )
    OR (
      entry_type = 'finding_and_procedure'
      AND NULLIF(btrim(finding), '') IS NOT NULL
      AND NULLIF(btrim(procedure_text), '') IS NOT NULL
    )
  ),
  CONSTRAINT dental_chart_entries_visit_same_clinic_fk
    FOREIGN KEY (clinic_id, visit_id)
    REFERENCES public.visits (clinic_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT dental_chart_entries_recorder_same_clinic_fk
    FOREIGN KEY (clinic_id, recorded_by)
    REFERENCES public.clinic_memberships (clinic_id, user_id)
    ON DELETE RESTRICT
);

CREATE INDEX dental_chart_entries_visit_created_idx
  ON public.dental_chart_entries (clinic_id, visit_id, created_at, id);

ALTER TABLE public.dental_chart_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.dental_chart_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.dental_chart_entries TO authenticated;

CREATE POLICY dental_chart_entries_clinician_read
ON public.dental_chart_entries
FOR SELECT
TO authenticated
USING (
  public.is_clinic_member_as(clinic_id, 'admin'::public.user_role_enum)
  OR public.is_clinic_member_as(clinic_id, 'doctor'::public.user_role_enum)
);

CREATE POLICY dental_chart_entries_clinician_create
ON public.dental_chart_entries
FOR INSERT
TO authenticated
WITH CHECK (
  recorded_by = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM public.clinic_memberships AS membership
    JOIN public.visits AS visit
      ON visit.id = dental_chart_entries.visit_id
     AND visit.clinic_id = dental_chart_entries.clinic_id
    LEFT JOIN public.appointments AS appointment
      ON appointment.id = visit.appointment_id
     AND appointment.clinic_id = visit.clinic_id
    WHERE membership.clinic_id = dental_chart_entries.clinic_id
      AND membership.user_id = auth.uid()
      AND (
        membership.role = 'admin'
        OR (
          membership.role = 'doctor'
          AND visit.doctor_id = auth.uid()
        )
      )
      AND (
        visit.appointment_id IS NULL
        OR appointment.status = 'in_progress'
      )
  )
);

COMMIT;