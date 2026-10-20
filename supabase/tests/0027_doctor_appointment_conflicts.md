# Doctor slot conflict verification

Migration 0027 has not been applied to Development or Production.

Existing required `start_time` and `end_time` define each slot. The UI already
offers durations of 15, 30, 45, 60, 90 and 120 minutes (initial selection 30).
No duration default is introduced by this milestone.

Scheduled, confirmed, arrived, waiting and in-progress appointments reserve
their scheduled interval. Completed, cancelled and no-show appointments do not.
Slots use clinic-local date/time and cannot span midnight under the existing
booking contract. A null doctor does not reserve a doctor's slot.

## Local integration tests

Install Python 3 and PostgreSQL client `psql`; use a disposable local PostgreSQL
server with `btree_gist` available. The specified local admin must be able to
create/drop a database and install the extension. Run from the repository root:

```powershell
python supabase/tests/0027_doctor_appointment_conflicts_test.py --local-admin-url postgresql://localhost/postgres
```

The harness refuses remote URLs, creates a uniquely named test database, applies
the actual migration to a minimal schema, then drops that database in cleanup.
It tests overlaps (equal, contained, containing, left/right partial), each active
status, adjacency, cancellation reuse, terminal statuses, distinct doctor/clinic/
date, scheduling and status updates, positive duration, and two concurrent
sessions with both winner commit and rollback. It does not verify Supabase
authentication, existing triggers, booking RPC integration or RLS.

## Before any later authorized database application

Review the following read-only preflight results in the intended environment.
Do not automatically cancel or alter any existing appointment to make it pass.

```sql
SELECT id, clinic_id, doctor_id, appointment_date, start_time, end_time
FROM public.appointments
WHERE doctor_id IS NOT NULL
  AND status IN ('scheduled', 'confirmed', 'arrived', 'waiting', 'in_progress')
  AND end_time <= start_time;

SELECT a.id AS first_appointment, b.id AS second_appointment,
       a.clinic_id, a.doctor_id, a.appointment_date
FROM public.appointments a
JOIN public.appointments b
  ON a.id < b.id AND a.clinic_id = b.clinic_id
 AND a.doctor_id = b.doctor_id AND a.appointment_date = b.appointment_date
 AND a.start_time < b.end_time AND b.start_time < a.end_time
WHERE a.status IN ('scheduled', 'confirmed', 'arrived', 'waiting', 'in_progress')
  AND b.status IN ('scheduled', 'confirmed', 'arrived', 'waiting', 'in_progress');
```

Resolve any returned records through clinic-approved scheduling decisions first.
The migration fails atomically if existing records violate either constraint.
It installs `btree_gist` if absent and builds a GiST exclusion index under an
ALTER TABLE lock; schedule application appropriately for the clinic's workload.
No policies, permissions, RPC signatures or existing migrations are changed.

After a separately authorized application to a test environment, verify through
the existing booking UI: overlapping requests show the conflict message, adjacent
slots succeed, cancelled slots can be reused, and retrying the same encounter
still returns its existing appointment. Repeat using two distinct patients and
encounters concurrently; only one overlapping booking should persist and the
losing encounter should remain available for a different slot. Verify existing
cross-clinic and inactive-user denial checks as regression coverage.
