-- Reserve half-open [start, end) slots for active appointments only.
-- Existing overlaps/zero-length active bookings must be reviewed manually:
-- this migration intentionally fails rather than changing clinic records.
BEGIN;
SET LOCAL search_path = pg_catalog, public, extensions;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_active_positive_duration CHECK (
    doctor_id IS NULL
    OR status NOT IN ('scheduled', 'confirmed', 'arrived', 'waiting', 'in_progress')
    OR end_time > start_time
  );

-- An exclusion constraint checks uncommitted competing index entries too.
-- It covers INSERT and scheduling/status/doctor updates without an RPC-only
-- check or a race-prone SELECT-before-INSERT. SQLSTATE: 23P01.
ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_doctor_slot_excl
  EXCLUDE USING gist (
    clinic_id WITH =,
    doctor_id WITH =,
    tsrange(appointment_date + start_time, appointment_date + end_time, '[)') WITH &&
  )
  WHERE (doctor_id IS NOT NULL AND status IN (
    'scheduled', 'confirmed', 'arrived', 'waiting', 'in_progress'
  ));

COMMIT;
