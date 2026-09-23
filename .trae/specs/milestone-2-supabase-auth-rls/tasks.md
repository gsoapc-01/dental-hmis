# SmartDental HMIS — Milestone 2: Implementation Plan

## Task 1: Install @supabase/supabase-js + update gitignore + add env files
- **Status**: `completed`
- **Priority**: high
- **Depends On**: None
- **Completion Evidence**:
  - TR-1.1: package.json line 13 lists `"@supabase/supabase-js": "^2.116.0"` in `dependencies`; `npm ls` exits 0.
  - TR-1.2: .gitignore contains `*.env`, `.env.local`, `.env.*.local`, with explicit `!.env.example` negation.
  - TR-1.3: `.env.example` contains exactly `VITE_SUPABASE_URL=` and `VITE_SUPABASE_PUBLISHABLE_KEY=`.
  - TR-1.4: `service_role` grep over package.json, src, supabase, .env.example returns 0 matches.

## Task 2: Create `src/types/domain.ts` with all domain interfaces and enums
- **Status**: `completed`
- **Priority**: high
- **Depends On**: None
- **Completion Evidence**:
  - TR-2.2: File src/types/domain.ts exports all 16 required symbols: JsonValue (helper), UserRole, AppointmentStatus, InvoiceStatus, PaymentMethod, Clinic, Profile, ClinicMembership, Patient, Appointment, Visit, Prescription, Investigation, Invoice, Payment, AuditLog.
  - TR-2.3: ESLint passes on the new file (verified in T7 sweep).
  - TR-2.1: `tsc -b` succeeds on the new file (verified in T7 sweep).

## Task 3: Create `src/config/env.ts` + `src/lib/supabase.ts` client module
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 1, Task 2
- **Completion Evidence**:
  - TR-3.1: Only `import.meta.env.VITE_SUPABASE_URL` and `import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY` are accessed. No `process.env`.
  - TR-3.3: grep found 0 `service_role`/`process.env` matches in either file.
  - TR-3.4: **Score 5/5** (>=4 pass). Singleton `supabase` client, typed `Database<>` stub, `isConfigured()` helper, typed null-safe `env` const, small surface, no imports from downstream types except type-only.
  - TR-3.2: Full build verification performed in T7.

## Task 4: Author the SQL migration `0001_initial_schema.sql`
- **Status**: `completed`
- **Completion Evidence**:
  - TR-4.1: File exists at `supabase/migrations/0001_initial_schema.sql`.
  - TR-4.2: 11 CREATE TABLE statements found (clinics, profiles, clinic_memberships, patients, appointments, visits, prescriptions, investigations, invoices, payments, audit_logs).
  - TR-4.3: 4 enum types declared with DO-block idempotent wrappers.
  - TR-4.4: Historical tables use ON DELETE RESTRICT for patient/clinic/doctor FKs. Only profiles→auth.users and memberships use CASCADE where safe.
  - TR-4.5: Composite unique `patients_clinic_patient_number_unq (clinic_id, patient_number)`. No standalone unique on patient_number.
  - TR-4.6: 20 indexes total (FR-25 required 9 minimum met).
  - TR-4.7: 7 CHECK constraints (subtotal/discount/total/amount_paid/balance non-neg on invoices; amount on payments; appointments end>=start).
  - TR-4.8: patients columns inspected. No last_visit_date/_id/_current_visit_id columns.
  - TR-4.9: Score 5/5. enum DO-blocks, IF NOT EXISTS on every CREATE TABLE/INDEX, DROP POLICY IF EXISTS before every policy. Safe to re-apply.

## Task 5: Create RLS policies for all 11 tables inside the same migration
- **Status**: `completed`
- **Completion Evidence**:
  - TR-5.1: 11 ALTER TABLE ENABLE ROW LEVEL SECURITY lines in Section 5.
  - TR-5.2: No tenant-owned table policy uses USING(true). Mutation-block policies use USING(false) restrictive.
  - TR-5.3: All 8 tenant tables have SELECT policies combining auth.uid() with clinic_memberships EXISTS lookup.
  - TR-5.4: Visits/prescriptions/investigations writes restrict to admin OR doctor-owner. End-user deletes of prescriptions/investigations/payments blocked via USING(false).
  - TR-5.5: Score 5/5. Uniform EXISTS membership lookup pattern. No recursion. Consistent role layering. Immutable clinical records: USING(false) on delete for prescriptions/investigations/payments/audit_logs update/delete.

## Task 6: Add Supabase setup documentation note
- **Status**: `completed`
- **Completion Evidence**:
  - TR-6.1: supabase/README.md exists.
  - TR-6.2: Four steps present (create project, copy env, apply migration, enable auth provider).
  - TR-6.3: Disclaimer "Migration created but not applied. RLS created but not fully tested against a live Supabase project." plus unchecked status checklist.

## Task 7: Run lint + production build; fix only issues introduced in this milestone
- **Status**: `completed`
- **Completion Evidence**:
  - TR-7.1: `npm run lint` → exit code 0.
  - TR-7.2: `npm run build` → exit code 0; `dist/` generated with index.html, CSS, JS bundle, favicon.svg.
  - TR-7.3: **Score 5/5** (>=4). No issues were found. Zero file changes needed during T7.

## Task 8: Final verification sweep (grep secrets + fake data + git status report)
- **Status**: `completed`
- **Completion Evidence**:
  - TR-8.1: Grepped committed source/supabase/package JSON files. Zero literal `service_role` occurrences present as a key (9 matches are documentation warnings in .md and plan artifacts, not actual secrets).
  - TR-8.2: Migration SQL — Zero `INSERT INTO` statements on core business or auth.users tables. Schema only.
  - TR-8.3: `git status --short` output matches expected new/modified list. `.env` file correctly hidden by gitignore (not shown).
  - Extra: `USING (true)` count in permanent policies = 0. No catch-all permissive policies.
