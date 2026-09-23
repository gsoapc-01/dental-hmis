# SmartDental HMIS — Milestone 2: Supabase + Auth + Multi-Tenant Foundation + Roles + RLS

## Overview
- **Summary**: Establish the secure, reproducible backend foundation that all future HMIS modules depend on: Supabase client integration, environment config, PostgreSQL schema (clinic/tenant, users/memberships, patients, appointments, visits, prescriptions, investigations, invoices, payments, audit log), Row Level Security policies, and TypeScript domain types.
- **Purpose**: Guarantee tenant isolation, enforce database-level authorization, and provide immutable clinical history with referential integrity. Future clinical and admin modules will sit on top of this foundation without re-architecting security.
- **Target Users**: Engineering team implementing future modules; first-deployed clinic tenant (admin/doctor/receptionist/patient roles at the DB layer only); future multi-tenant SaaS operators.

## Goals
1. Connect the React application to Supabase with the official public client, using only publishable-key environment variables.
2. Create a single reproducible PostgreSQL migration file that defines every core table, enum, foreign key, index, constraint, and RLS policy.
3. Implement multi-tenancy via `clinic_id` on every tenant-owned table, with RLS enforcing that an authenticated user can only access rows for clinics they have a membership in.
4. Establish auth.users → profiles → clinic_memberships → clinic membership chain, with a constrained `role` enum (admin / doctor / receptionist / patient).
5. Enforce the historical clinical record invariant: 1 patient → many visits, each visit owns its prescriptions/investigations; never mutate prior visit data via schema design.
6. Provide audit_logs table as a structured foundation for future event logging.
7. Provide minimal frontend scaffolding (shared Supabase client module, env placeholders, domain types) that compiles cleanly against the strict TS config.
8. Leave NO insecure temporary artifacts behind: no fake credentials, no `anon key in source`, no "allow all" RLS policies, no disabled RLS.

## Non-Goals
- Building ANY user-facing UI (patient registration, dashboards, appointment calendar, billing screen, odontogram, patient portal, prescription UI, investigation UI).
- Implementing authentication UI flows (login, sign-up, password reset screens).
- Creating a full RBAC / permission engine beyond the 4-role enum + basic membership-based RLS.
- Installing Supabase CLI tooling or applying the migration to a live project in this repository step.
- Creating a clinic, seeding fake patients, or making a real Supabase project connection.
- Implementing patient_number auto-generation triggers / sequences in this milestone (schema + uniqueness constraints only, logic deferred).
- Generating hundreds of component files.

## Background & Context
- Project is at commit `bd45bad` — "Initial project foundation" (React + Vite + TypeScript + ESLint, minimal landing screen, build + lint passing, clean working tree).
- Project root: `E:\smartdental-hmis`. Repository `dental-hmis` with main branch pushed.
- No Supabase directory, no `.sql` files, no `.env*` files, no migrations exist yet (inspected 2026-09-16).
- Product will be a multi-tenant dental SaaS. First clinic is the first customer, not a hard-coded identity.
- Future architecture (confirmed): Supabase/PostgreSQL, Supabase Auth, PostgreSQL RLS, Vercel or similar.
- Strict TS flags active: `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`.

## Functional Requirements

### Supabase Integration (Part 1)
- **FR-1**: Project depends on exactly one new runtime package: the official `@supabase/supabase-js` client.
- **FR-2**: Frontend configuration uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` env vars only. No service_role key anywhere.
- **FR-3**: A `.env.example` file is committed with placeholders. A local `.env` file (if used) is ignored by Git.
- **FR-4**: A TypeScript-exported singleton Supabase client module exists under `src/lib/` and is importable without TS errors.

### Database Schema (Part 2 — Core Entities)
- **FR-5**: `clinics` table exists with: `id uuid pk`, name, logo, favicon, primary/secondary/accent colors, address, phone, email, website, whatsapp, tagline, currency, timezone, created_at, updated_at. Non-branding fields nullable.
- **FR-6**: `profiles` table exists linked 1:1 to `auth.users(id)` via FK `on delete cascade`. Carries user display name, avatar_url, created_at, updated_at.
- **FR-7**: `clinic_memberships` junction table exists: `(user_id uuid fk profiles, clinic_id uuid fk clinics, role user_role_enum)`. Composite PK `(user_id, clinic_id)`. Unique per user+clinic.
- **FR-8**: `user_role_enum` PostgreSQL type defined as: `admin`, `doctor`, `receptionist`, `patient`.
- **FR-9**: `patients` table with all listed clinical/contact fields. `clinic_id` FK, `patient_number text NOT NULL`. Patient_number unique only per clinic (partial/composite unique: `(clinic_id, patient_number)`). All medical fields nullable except those explicitly required.
- **FR-10**: `appointments` table with FKs to clinic, patient, doctor (profile), created_by (profile). Fields: date, start_time, end_time, service/reason text, notes, status enum, timestamps. `appointment_status_enum` = scheduled / confirmed / arrived / waiting / in_progress / completed / cancelled / no_show.
- **FR-11**: `visits` table with FKs to clinic, patient, doctor, appointment (nullable). visit_date timestamp. Fields: chief_complaint, hpi, vital_signs (jsonb), examination, assessment, treatment_plan, clinical_notes, follow_up_date, follow_up_instructions, timestamps. NOT NULL on clinic_id + patient_id + doctor_id + visit_date.
- **FR-12**: `prescriptions` table with FKs to clinic, patient, visit, prescribing_doctor (profile). Fields: medicine, strength, dose, route, frequency, duration, quantity, instructions, created_at.
- **FR-13**: `investigations` table with FKs to clinic, patient, visit, requesting_doctor (profile). Fields: investigation_type, status, result text, result_date, notes, timestamps.
- **FR-14**: `invoices` table with FKs to clinic, patient, visit (nullable). Fields: invoice_number (unique per clinic), status enum (draft/paid/partially_paid/cancelled/void), subtotal numeric, discount numeric default 0, total numeric, amount_paid default 0, balance (computed concept, stored as numeric), currency text not null (copied from clinic for historical immutability), timestamps.
- **FR-15**: `payments` table with FKs to clinic, invoice, patient, recorded_by (profile). Fields: payment_method_enum (cash/mobile_money/card/bank/insurance/other), amount numeric, reference text, payment_date timestamp, created_at.
- **FR-16**: `audit_logs` table: id uuid pk, clinic_id nullable, actor_user_id nullable fk profiles, table_name text, record_id uuid, action text, old_data jsonb, new_data jsonb, metadata jsonb, created_at timestamptz default now().

### Multi-Tenancy & RLS (Critical)
- **FR-17**: Every tenant-owned table carries `clinic_id uuid NOT NULL REFERENCES clinics(id)`. (Memberships, profiles, and future system-wide tables are the only exceptions.)
- **FR-18**: RLS is ENABLED on every table listed in FR-5 through FR-16. No table has RLS disabled.
- **FR-19**: A `auth_uid()` stable helper function or direct `auth.uid()` usage resolves the current authenticated user id inside RLS policies consistently.
- **FR-20**: For every tenant-owned table, a SELECT policy restricts rows to those whose `clinic_id` appears in `clinic_memberships` for the calling user.
- **FR-21**: INSERT/UPDATE/DELETE policies are scoped to membership. Additionally, UPDATE/DELETE of historical clinical records (visits, prescriptions, investigations, invoices post-finalization, payments) are either restricted to admin role or disallowed entirely at the RLS layer per clinical-history invariant.
- **FR-22**: No policy uses recursion-unfriendly subqueries that would re-trigger policy evaluation. Use `security_invoker = false` views or direct membership lookups; avoid self-referential subqueries.
- **FR-23**: Clinic memberships themselves use RLS: users can see their own memberships; admins can see memberships of their clinic.

### Referential Integrity, Deletion, Indexes
- **FR-24**: FK delete semantics: historical clinical data (visits, prescriptions, investigations, invoices, payments, audit_logs) use `ON DELETE RESTRICT` on patient/clinic/doctor references so records cannot be erased accidentally. Only leaf records where architecturally safe use `CASCADE`.
- **FR-25**: Indexes exist for: `patients(clinic_id, patient_number)`, `patients(clinic_id, first_name, last_name)`, `patients(clinic_id, phone)`, `patients(clinic_id, email)`, `visits(clinic_id, patient_id, visit_date DESC)`, `appointments(clinic_id, appointment_date)`, `invoices(clinic_id, invoice_number)`, `payments(invoice_id)`, `clinic_memberships(clinic_id, role)`, `audit_logs(clinic_id, created_at DESC)`.
- **FR-26**: Check constraints: monetary fields (`subtotal`, `total`, `amount_paid`, `balance`, `discount`, `amount`) must be >= 0. End_time >= start_time on appointments. Dates/timestamps where required.

### Frontend Scaffolding
- **FR-27**: `src/config/env.ts` reads `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` with type-safe accessors (throws descriptive error if missing at module init for dev only, or returns null for production safety).
- **FR-28**: `src/lib/supabase.ts` exports a `createClient(...)` singleton using `import.meta.env`. Exports type `Database` alias (stubbed shape matching tables, sufficient for TS compile; not full generated types).
- **FR-29**: `src/types/domain.ts` exports TypeScript interfaces for Clinic, Profile, ClinicMembership, UserRole, Patient, Appointment, AppointmentStatus, Visit, Prescription, Investigation, Invoice, InvoiceStatus, Payment, PaymentMethod, AuditLog aligned with schema.
- **FR-30**: `.gitignore` updated to include `.env`, `.env.local`, `.env.*.local` (keeping `.env.example` tracked).

## Non-Functional Requirements
- **NFR-1**: Migration idempotency — use `CREATE TABLE IF NOT EXISTS`, `CREATE TYPE IF NOT EXISTS` (or `DO $$` blocks for enums), `CREATE INDEX IF NOT EXISTS`, `CREATE POLICY` with drop-if-exists guards where PostgreSQL lacks IF NOT EXISTS.
- **NFR-2**: Build & lint green — `npm run lint` exits 0; `npm run build` exits 0 after changes; no unused imports per strict TS.
- **NFR-3**: No secret leakage — grep of the repo for "service_role" finds 0 matches. grep of committed files for real-looking Supabase URLs finds 0 matches (only placeholders allowed in `.env.example`).
- **NFR-4**: Schema clarity — SQL file has section comments grouping tables by domain; column order is consistent (PK → tenant FK → business FKs → enums/texts → booleans/numerics → jsonb → timestamps).
- **NFR-5**: Strict TS compatibility — all new `.ts` files compile with `tsconfig.app.json` (`verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`).
- **NFR-6**: Minimal dependency footprint — only `@supabase/supabase-js` added.
- **NFR-7**: Manual-setup clarity — README or inline comment near migration documents the exact manual steps required if the project owner has not yet provisioned a Supabase project and run the migration (not a full README rewrite — one short `SETUP.md` note or section).

## Constraints
- **Technical**:
  - Must preserve existing Vite/React/TypeScript/ESLint configuration untouched unless a concrete issue requires change.
  - Cannot install a UI library, Supabase CLI, or ORM (Prisma/Drizzle/etc.).
  - Cannot disable RLS; cannot create a temporary permissive policy and leave it.
  - Must use `pg_catalog.uuid_generate_v4()` or `gen_random_uuid()` for PKs (PostgreSQL 13+).
  - Must use `timestamptz` for all time-bearing columns.
- **Business**:
  - No hardcoded clinic identity (no default `clinic_id = 1` or hardcoded currency).
  - Historical clinical records must not be deletable by non-admin paths.
  - Patient numbers must be per-clinic, not globally unique.
- **Dependencies**:
  - Manual Supabase project provisioning is external (not done in this milestone).
  - Migration execution against a live DB is external if Supabase CLI is not available.

## Assumptions
- Supabase PostgreSQL >= 15, with the `pgcrypto` or built-in `gen_random_uuid()` available.
- The standard Supabase `auth.users` table (managed by Supabase Auth) exists and has a `uuid id` PK.
- `authenticator`, `anon`, and `authenticated` roles exist (Supabase standard); RLS policies grant to `authenticated` only where appropriate, and public access is never granted to tenant-owned data.
- `uuid-ossp` extension is enabled or `gen_random_uuid()` works in the target Supabase region.
- Migration files stored in the repository at `supabase/migrations/<filename>.sql` (the convention Supabase CLI expects) even if CLI is not installed today.
- Incremental migrations will be used for future schema changes; today we create one cohesive first migration named `0001_initial_schema.sql` that is complete for milestone 2.

## Open Questions
- [ ] (Resolved with NFR-7) Do we want a Supabase CLI `config.toml` scaffold now even without CLI installed? Scope says no — create `supabase/migrations/` folder only, defer `config.toml`.
- [ ] (Resolved FR-9 / FR-14) Patient number / invoice number auto-generation — left to next milestone; only (clinic_id, number) unique constraints exist now.
- [ ] (Resolved NFR-1) PostgreSQL 15+ lacks `CREATE TYPE IF NOT EXISTS`. We will use a safe `DO $$ ... BEGIN CREATE TYPE ... EXCEPTION WHEN duplicate_object THEN NULL; END; $$;` wrapper for enum types.

## Acceptance Criteria

### AC-1: Supabase client package installed and configured
- **Type**: `rule`
- **Given**: Fresh `npm install` on the modified repo
- **When**: `npm ls @supabase/supabase-js` is run AND `grep -r "service_role" package* src/ supabase/` returns empty
- **Then**: Supabase JS appears exactly once in the dependency tree and no service_role key string appears in source or config
- **Pass Condition**: exit codes 0 for ls, 0 empty for grep
- **Evidence**: `npm ls` output + grep output captured in task completion

### AC-2: Environment files correct (.gitignore + .env.example)
- **Type**: `rule`
- **Given**: Committed working tree
- **When**: `.gitignore` is read AND `.env.example` is read
- **Then**: `.gitignore` contains patterns `*.env`, `.env.local`, `.env.*.local` (excluding `.env.example` from ignore); `.env.example` contains exactly `VITE_SUPABASE_URL=` and `VITE_SUPABASE_PUBLISHABLE_KEY=` with empty values
- **Pass Condition**: Both patterns present; only placeholders present in example
- **Evidence**: File contents of `.gitignore` and `.env.example`

### AC-3: Single reproducible migration file exists
- **Type**: `rule`
- **Given**: Repository tree
- **When**: `supabase/migrations/` directory is listed
- **Then**: Exactly one `.sql` migration file exists named `0001_initial_schema.sql`, no other `.sql` files exist
- **Pass Condition**: Directory listing matches exactly
- **Evidence**: Directory listing of `supabase/migrations/`

### AC-4: All 11 required tables present in migration with required columns
- **Type**: `rule`
- **Given**: Migration file content
- **When**: Grep for each table name (`CREATE TABLE` followed by table identifier)
- **Then**: The following all match: clinics, profiles, clinic_memberships, patients, appointments, visits, prescriptions, investigations, invoices, payments, audit_logs. Each table carries `clinic_id` where required by FR-17.
- **Pass Condition**: All 11 table definitions found. Required clinic_id columns present (excluding profiles/clinics themselves).
- **Evidence**: Structured grep output with line numbers from the migration file

### AC-5: Enum types with database constraints
- **Type**: `rule`
- **Given**: Migration file
- **When**: Search for enum type creation and column type usage
- **Then**: Three enums are created safely with idempotent guards: `user_role_enum` (admin/doctor/receptionist/patient), `appointment_status_enum` (8 values), `invoice_status_enum` (draft/paid/partially_paid/cancelled/void), `payment_method_enum` (6 values). Columns that use these types declare them and have NOT NULL where required.
- **Pass Condition**: All four enums declared with safe guards; every related column references the correct type.
- **Evidence**: Grep of migration for `CREATE TYPE`, enum value lists, and column declarations.

### AC-6: Foreign keys with correct DELETE semantics
- **Type**: `rule`
- **Given**: Migration file
- **When**: Inspect FK declarations
- **Then**: Every reference from historical tables (visits, prescriptions, investigations, invoices, payments, audit_logs) to patients/clinics/doctors uses `ON DELETE RESTRICT` or `ON DELETE NO ACTION`. Only soft/system references (e.g. profiles → auth.users) may use CASCADE.
- **Pass Condition**: No `ON DELETE CASCADE` on historical clinical data references.
- **Evidence**: Line-by-line FK reference audit in the completion log.

### AC-7: Patient number unique per clinic only
- **Type**: `rule`
- **Given**: Patients table definition
- **When**: Search for UNIQUE constraints on patients
- **Then**: A single composite constraint `UNIQUE (clinic_id, patient_number)` exists. No standalone `UNIQUE (patient_number)` global constraint exists.
- **Pass Condition**: Composite constraint found; no global unique.
- **Evidence**: `UNIQUE` definition lines from migration.

### AC-8: RLS enabled on every table with membership-scoped policies
- **Type**: `rule`
- **Given**: Migration file
- **When**: Search for `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `CREATE POLICY`
- **Then**: Every table in AC-4 has exactly one `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` line. Every tenant-owned table has at least a SELECT policy scoped to clinic membership. No policy body contains `true` alone as a permissive catch-all for authenticated users across tenants.
- **Pass Condition**: 11 ALTER TABLE ENABLE RLS lines exist; policies reference clinic_memberships or equivalent scope; no bare `USING (true)` production policies.
- **Evidence**: Count of ALTER RLS + policy bodies.

### AC-9: Multi-tenancy enforcement architecture
- **Type**: `rubric`
- **Dimension**: Tenant isolation architecture clarity, depth, and safety
- **Scale**: 1–5
- **Anchors**: 1 = clinic_id missing on many tables or RLS gaps; 3 = clinic_id present but policies overly broad or some tables missing; 5 = every tenant-owned row scoped by clinic_id, RLS on all tables, policies use a membership lookup pattern that works across tables without recursion, and admin/role restrictions overlay correctly.
- **Pass Threshold**: >= 4
- **Evidence**: Code inspection of RLS policy blocks + FK structure.

### AC-10: Index coverage aligns with FR-25
- **Type**: `rule`
- **Given**: Migration file
- **When**: Count CREATE INDEX statements
- **Then**: At minimum every index listed in FR-25 exists, using IF NOT EXISTS. No excessively redundant overlapping B-trees.
- **Pass Condition**: Count matches; column orders make sense for leftmost prefix usage.
- **Evidence**: Index listing with line numbers.

### AC-11: Monetary non-negative + appointment temporal check constraints
- **Type**: `rule`
- **Given**: Migration file
- **When**: Search for CHECK constraints
- **Then**: `CHECK (subtotal >= 0)`, `CHECK (total >= 0)`, `CHECK (discount >= 0)`, `CHECK (amount_paid >= 0)`, `CHECK (balance >= 0)` on invoices; `CHECK (amount >= 0)` on payments; `CHECK (end_time >= start_time)` on appointments.
- **Pass Condition**: All 7 check constraints found.
- **Evidence**: Grep of CHECK definitions.

### AC-12: Audit logs table schema ready
- **Type**: `rule`
- **Given**: Migration file
- **When**: Inspect audit_logs DDL
- **Then**: Columns match FR-16 exactly; `created_at timestamptz default now()`, jsonb fields present, actor FK optional. RLS is enabled with a policy scoped to clinic membership.
- **Pass Condition**: All 9 fields exist, RLS enabled, policy present.
- **Evidence**: DDL lines.

### AC-13: Frontend Supabase client module compiles (no runtime needed)
- **Type**: `rule`
- **Given**: Modified source tree
- **When**: `npm run build` completes
- **Then**: `src/lib/supabase.ts` exports a client factory or instance; `src/config/env.ts` exposes env vars; `src/types/domain.ts` exports the 13 domain interfaces/enums. No TS errors, no unused-import violations.
- **Pass Condition**: Build exits 0 and the 3 files exist with the declared exports.
- **Evidence**: `npm run build` stdout + file listing.

### AC-14: Lint clean
- **Type**: `rule`
- **Given**: Modified source tree
- **When**: `npm run lint` runs
- **Then**: ESLint exits 0, no warnings displayed.
- **Pass Condition**: Exit code 0, empty warning output.
- **Evidence**: Command output.

### AC-15: No fake data, no secrets, no permissive throwaway policies
- **Type**: `rule`
- **Given**: Whole diff of the milestone
- **When**: Manual review + grep for INSERT statements into core tables, real-looking URLs, `USING (true)` in permanent policies
- **Then**: 0 seed INSERT statements in the migration; 0 real Supabase URLs in committed files; 0 `USING (true)` permanent policies outside of deliberate system tables.
- **Pass Condition**: All three counts 0.
- **Evidence**: Grep results.

### AC-16: Migration reproducibility approach (idempotency)
- **Type**: `rubric`
- **Dimension**: Idempotency and forward-safety of the SQL
- **Scale**: 1–5
- **Anchors**: 1 = fails on re-run due to duplicate CREATE without guards; 3 = most tables use IF NOT EXISTS but enums/indexes/policies would error on second run; 5 = every CREATE uses IF NOT EXISTS or DO-block safe wrappers, policies use DROP IF EXISTS before CREATE, the file can be executed twice against the same DB without error and without data loss.
- **Pass Threshold**: >= 4
- **Evidence**: Code inspection of guards.

### AC-17: Visit history invariant enforced by schema
- **Type**: `rule`
- **Given**: Patients + visits table definitions
- **When**: Inspect patients columns and visit RLS write policies
- **Then**: `patients` table does NOT contain any of: `last_visit_date`, `last_visit_id`, `current_visit_id` as columns. Visits UPDATE/DELETE RLS policy on non-admin roles is RESTRICTed or absent.
- **Pass Condition**: Absence of last-visit columns in patients; restrictive write RLS on visits.
- **Evidence**: Column listing of patients + RLS write policies.

### AC-18: Explicit documentation of required manual steps
- **Type**: `rule`
- **Given**: Repository tree after implementation
- **When**: Read `supabase/README.md` or equivalent note
- **Then**: Document states (1) create a Supabase project, (2) copy `.env.example` → `.env` and fill values from Project Settings → API, (3) run `supabase/migrations/0001_initial_schema.sql` in the SQL Editor or via CLI, (4) enable email/password or chosen provider in Auth → Settings.
- **Pass Condition**: Four steps present. No claim that migration was applied.
- **Evidence**: Note contents.
