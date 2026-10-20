"""Constraint integration tests using real, independent PostgreSQL sessions.

Run: python supabase/tests/0027_doctor_appointment_conflicts_test.py --local-admin-url postgresql://localhost/postgres
Requires psql and a local admin able to CREATE DATABASE and install btree_gist.
Creates/drops a disposable database; never runs against a clinic database.
Applies the actual 0027 migration to a minimal appointment schema. This tests
database scheduling enforcement, not the existing Supabase Auth/RLS/RPC flows.
"""

import argparse
from pathlib import Path
import shutil
import subprocess
import unittest
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[2]
ACTIVE = ('scheduled', 'confirmed', 'arrived', 'waiting', 'in_progress')
CLINIC = '00000000-0000-0000-0000-000000000001'
DOCTOR = '00000000-0000-0000-0000-000000000002'


def sql(statement, *, check=True):
    result = subprocess.run(
        ['psql', DATABASE_URL, '-X', '-v', 'ON_ERROR_STOP=1',
         '-v', 'VERBOSITY=verbose', '-qAt'],
        input=statement, text=True, capture_output=True, timeout=20,
    )
    if check and result.returncode:
        raise AssertionError(result.stderr)
    return result


def booking(start='09:00', end='10:00', status='scheduled',
            doctor=DOCTOR, clinic=CLINIC, day='2030-01-01'):
    return (
        'INSERT INTO public.appointments '
        '(clinic_id, doctor_id, appointment_date, start_time, end_time, status) '
        f"VALUES ('{clinic}', '{doctor}', '{day}', '{start}', '{end}', '{status}');"
    )


class AppointmentConflicts(unittest.TestCase):
    def setUp(self):
        sql('TRUNCATE public.appointments;')

    def assert_conflict(self, statement):
        result = sql(statement, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('23P01', result.stderr)
        self.assertIn('appointments_doctor_slot_excl', result.stderr)

    def test_overlaps_and_all_active_statuses(self):
        for status in ACTIVE:
            with self.subTest(status=status):
                sql('TRUNCATE public.appointments;' + booking(status=status))
                for start, end in [('09:00', '10:00'), ('09:15', '09:45'),
                                   ('08:30', '10:30'), ('08:30', '09:30'),
                                   ('09:30', '10:30')]:
                    self.assert_conflict(booking(start, end))

    def test_adjacent_slots(self):
        sql(booking() + booking('08:00', '09:00') + booking('10:00', '11:00'))
        self.assertEqual(sql('SELECT count(*) FROM public.appointments;').stdout.strip(), '3')

    def test_cancelled_slot_reuse(self):
        sql(booking() + "UPDATE public.appointments SET status='cancelled';" + booking())

    def test_terminal_statuses_do_not_reserve(self):
        for status in ('completed', 'cancelled', 'no_show'):
            sql(booking(status=status))
        sql(booking())

    def test_other_doctor_clinic_or_date(self):
        sql(booking() + booking(doctor=str(uuid4())) + booking(clinic=str(uuid4()))
            + booking(day='2030-01-02'))

    def test_updates_cannot_create_overlap(self):
        sql(booking() + booking('10:00', '11:00'))
        self.assert_conflict("UPDATE public.appointments SET start_time='09:30' WHERE start_time='10:00';")
        sql(booking(status='cancelled'))
        self.assert_conflict("UPDATE public.appointments SET status='scheduled' WHERE status='cancelled';")

    def test_zero_duration_rejected(self):
        result = sql(booking('09:00', '09:00'), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('23514', result.stderr)

    def race(self, finish):
        first = subprocess.Popen(
            ['psql', DATABASE_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-qAt'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        try:
            first.stdin.write('BEGIN;\n' + booking() + '\n\\echo RESERVED\n')
            first.stdin.flush()
            # The first INSERT has finished but is deliberately uncommitted.
            self.assertEqual(first.stdout.readline().strip(), 'RESERVED')
            second = subprocess.Popen(
                ['psql', DATABASE_URL, '-X', '-v', 'ON_ERROR_STOP=1',
                 '-v', 'VERBOSITY=verbose', '-qAt'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True,
            )
            try:
                second.stdin.write(booking('09:30', '10:30') + '\n')
                second.stdin.flush()
                # A competing INSERT must wait while the first slot is uncommitted.
                with self.assertRaises(subprocess.TimeoutExpired):
                    second.wait(timeout=1)
                first.stdin.write(finish + ';\n')
                first.stdin.flush()
                first.communicate(timeout=10)
                self.assertEqual(first.returncode, 0)
                _, error = second.communicate(timeout=10)
                return second.returncode, error
            finally:
                if second.poll() is None:
                    second.kill()
                    second.communicate()
        finally:
            if first.poll() is None:
                first.kill()
                first.communicate()

    def test_concurrent_commit_rejects_second(self):
        code, error = self.race('COMMIT')
        self.assertNotEqual(code, 0)
        self.assertIn('23P01', error)
        self.assertEqual(sql('SELECT count(*) FROM public.appointments;').stdout.strip(), '1')

    def test_concurrent_rollback_allows_second(self):
        code, error = self.race('ROLLBACK')
        self.assertEqual(code, 0, error)
        self.assertEqual(sql('SELECT count(*) FROM public.appointments;').stdout.strip(), '1')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local-admin-url', required=True)
    args = parser.parse_args()
    parsed = urlsplit(args.local_admin_url)
    if parsed.scheme not in ('postgres', 'postgresql') or parsed.hostname not in ('localhost', '127.0.0.1', '::1') or parsed.query or parsed.fragment:
        parser.error('Only a localhost PostgreSQL URL without query/fragment is accepted.')
    if not shutil.which('psql'):
        parser.error('psql is required; no database was contacted.')
    name = 'soapsmile_conflicts_test_' + uuid4().hex
    DATABASE_URL = args.local_admin_url
    sql(f'CREATE DATABASE {name};')
    try:
        DATABASE_URL = urlunsplit(parsed._replace(path='/' + name))
        sql("CREATE TYPE public.appointment_status_enum AS ENUM ('scheduled', 'confirmed', 'arrived', 'waiting', 'in_progress', 'completed', 'cancelled', 'no_show');"
            'CREATE TABLE public.appointments (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, '
            'clinic_id uuid NOT NULL, doctor_id uuid, appointment_date date NOT NULL, '
            'start_time time NOT NULL, end_time time NOT NULL, '
            'status public.appointment_status_enum NOT NULL, CHECK (end_time >= start_time));')
        sql((ROOT / 'supabase/migrations/0027_doctor_appointment_conflicts.sql').read_text())
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(AppointmentConflicts))
    finally:
        DATABASE_URL = args.local_admin_url
        sql(f'DROP DATABASE {name} WITH (FORCE);')
    raise SystemExit(0 if result.wasSuccessful() else 1)
