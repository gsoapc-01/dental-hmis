# SmartDental HMIS Milestone 2 — Independent Review R1

This review is written by the implementer for the self-review gate. The next
time a reviewer is available this should be re-run from a fresh context for
true independence.

Checkpoints cover every AC in the spec.

---

## Independent Checkpoints

### CP-R1 — Supabase package installed, no service_role
- **Type**: `rule`
- **Covers**: AC-1
- **Evidence**:
  - `package.json` line 13: `"@supabase/supabase-js": "^2.116.0"` in `dependencies` ✅
  - Grep of committed source (`src/`, `supabase/`, `*.json`, `.env.example`) for `service_role` as a **key** returns 0 matches. 9 grep hits are documentation warnings in `.md` / `.trae/` artifacts, not real credentials. ✅
  - Result: **pass**

### CP-R2 — .gitignore updated correctly; .env.example has only placeholders
- **Type**: `rule`
- **Covers**: AC-2
- **Evidence**:
  - `.gitignore` lines 16–19: `*.env`, `.env.local`, `.env.*.local`, `!.env.example` ✅
  - `.env.example` contents: `VITE_SUPABASE_URL=\nVITE_SUPABASE_PUBLISHABLE_KEY=\n` ✅ (placeholders only, blank)
  - Result: **pass**

### CP-R3 — Exactly one reproducible migration file in expected location
- **Type**: `rule`
- **Covers**: AC-3
- **Evidence**:
  - `supabase/migrations/0001_initial_schema.sql` is the only `.sql` file ✅
  - Result: **pass**

### CP-R4 — All 11 tables + required columns + clinic_id on tenant tables
- **Type**: `rule`
- **Covers**: AC-4, AC-17 (partial: columns only; RLS part is CP-R8)
- **Evidence**:
  - `CREATE TABLE IF NOT EXISTS public.X` count = 11: clinics, profiles, clinic_memberships, patients, appointments, visits, prescriptions, investigations, invoices, payments, audit_logs ✅
  - clinic_id NOT NULL present on: patients, appointments, visits, prescriptions, investigations, invoices, payments; audit_logs carries it nullable ✅
  - clinics/clinic_memberships/profiles: profiles exempt per design (auth-level identity); clinic_memberships has clinic_id via PK; clinics table itself exempt (it IS the tenant) ✅
  - Result: **pass**

### CP-R5 — Four enum types with idempotent wrappers + correct usage
- **Type**: `rule`
- **Covers**: AC-5
- **Evidence**:
  - 4 DO-block-wrapped enums: `user_role_enum` (4 values), `appointment_status_enum` (8 values), `invoice_status_enum` (5 values), `payment_method_enum` (6 values) ✅
  - Columns match types: clinic_memberships.role, appointments.status, invoices.status, payments.payment_method ✅
  - Result: **pass**

### CP-R6 — FK DELETE semantics (historical data never CASCADEs)
- **Type**: `rule`
- **Covers**: AC-6
- **Evidence**:
  - CASCADE occurs only on: profiles→auth.users, memberships→profiles, memberships→clinics (system/identity level) ✅
  - All FKs from visits/prescriptions/investigations/invoices/payments to clinics/patients/doctors use `ON DELETE RESTRICT` ✅
  - Audit_logs uses SET NULL (audit log retains orphan row) ✅
  - Result: **pass**

### CP-R7 — Patient number unique per-clinic only; no last_visit columns
- **Type**: `rule`
- **Covers**: AC-7, AC-17 (column invariant)
- **Evidence**:
  - Migration line 137: `CONSTRAINT patients_clinic_patient_number_unq UNIQUE (clinic_id, patient_number)` ✅
  - Grep for `UNIQUE (patient_number)` standalone: 0 matches ✅
  - Grep for patients columns: no `last_visit_date`, `last_visit_id`, `current_visit_id` ✅
  - Result: **pass**

### CP-R8 — RLS enabled on all 11 tables + membership-scoped selects + no permissive policies
- **Type**: `rule`
- **Covers**: AC-8, AC-17 (RLS write policies)
- **Evidence**:
  - 11 `ALTER TABLE public.X ENABLE ROW LEVEL SECURITY` statements in Section 5 ✅
  - Every tenant-owned table (8) has a SELECT policy whose body joins `EXISTS (SELECT 1 FROM public.clinic_memberships m WHERE m.clinic_id = X.clinic_id AND m.user_id = auth.uid())` ✅
  - Permanent policies with `USING (true)`: 0. Mutation-block policies use `USING (false)` only, which is restrictive (not permissive). ✅
  - Visits/prescriptions/investigations UPDATE/DELETE RLS restricts to admin or doctor-owner. Prescriptions/Investigations/Payments/Audit_logs end-user DELETEs are disallowed via USING(false). ✅
  - Result: **pass**

### CP-U1 — Tenant isolation architecture quality
- **Type**: `rubric`
- **Covers**: AC-9
- **Scale**: 1–5
- **Anchors**: 1 = gaps / missing clinic_id or RLS; 3 = present but weak; 5 = rigorous uniform pattern, no recursion, role overlays logical.
- **Pass Threshold**: >= 4
- **Evidence**:
  - clinic_id column present on every tenant-owned row; NOT NULL except audit_logs (nullable for cross-clinic/tenant-agnostic events)
  - Uniform `EXISTS` subquery reused across every tenant table. No recursive self-joins. Policies never re-reference the target table in membership lookups.
  - Admin/doctor/receptionist role filtering layered consistently. Historical clinical records (prescriptions/investigations/payments delete; audit_logs update/delete) explicitly immutable for end users via `USING(false)`.
  - **Score: 5/5** ✅ passes threshold.

### CP-R9 — Index coverage (FR-25 met)
- **Type**: `rule`
- **Covers**: AC-10
- **Evidence**:
  - 9 named FR-25 indexes + 11 supplementary clinic_id indexes = 20 total. All use IF NOT EXISTS.
  - Leftmost-prefix friendly: `(clinic_id, patient_number)`, `(clinic_id, first_name, last_name)`, `(clinic_id, phone)`, `(clinic_id, email)`, `(clinic_id, patient_id, visit_date DESC)`, `(clinic_id, appointment_date)`, `(clinic_id, invoice_number)`, `(invoice_id)`, `(clinic_id, role)`, `(clinic_id, created_at DESC)` ✅
  - Result: **pass**

### CP-R10 — Monetary non-negative + appointment temporal CHECKs
- **Type**: `rule`
- **Covers**: AC-11
- **Evidence**:
  - 7 CHECKs:
    - 155: appointments_times_check `end_time >= start_time`
    - 230–234: invoices subtotal/discount/total/amount_paid/balance >= 0
    - 249: payments amount >= 0
  - Count = 7 exactly ✅
  - Result: **pass**

### CP-R11 — Audit_logs schema + RLS enabled
- **Type**: `rule`
- **Covers**: AC-12
- **Evidence**:
  - 9 columns + PK: id, clinic_id, actor_user_id, table_name, record_id, action, old_data jsonb, new_data jsonb, metadata jsonb, created_at timestamptz default now() ✅
  - RLS enabled + policies: `audit_logs_admin_read` (admin); `audit_logs_system_insert` (admin); `audit_logs_no_update` (USING(false)); `audit_logs_no_delete` (USING(false)) ✅
  - Result: **pass**

### CP-R12 — Frontend modules compile
- **Type**: `rule`
- **Covers**: AC-13
- **Evidence**:
  - Three files exist: `src/config/env.ts`, `src/lib/supabase.ts`, `src/types/domain.ts` ✅
  - `tsc -b && vite build` exits 0. Dist assets generated. ✅
  - Domain exports: 4 literal unions + 12 interfaces + JsonValue helper = 17 symbols. All required names present. ✅
  - Result: **pass**

### CP-R13 — Lint clean
- **Type**: `rule`
- **Covers**: AC-14
- **Evidence**: `npm run lint` → exit 0. No warnings or errors. ✅ pass

### CP-R14 — No fake data / no secrets / no permissive throwaway policies
- **Type**: `rule`
- **Covers**: AC-15
- **Evidence**:
  - `INSERT INTO` core tables count: 0 ✅
  - Committed `.env.example`: both values blank strings ✅
  - `USING (true)` permanent: 0 ✅
  - Result: **pass**

### CP-U2 — Idempotency / reproducibility
- **Type**: `rubric`
- **Covers**: AC-16
- **Scale**: 1–5
- **Anchors**: 1 = fails on re-run; 3 = tables/indexes guarded, enums not; 5 = everything guarded incl. DO-block enums + DROP IF EXISTS policies + IF NOT EXISTS tables/indexes
- **Pass Threshold**: >= 4
- **Evidence**:
  - All 11 tables: `CREATE TABLE IF NOT EXISTS`
  - All 20 indexes: `CREATE INDEX IF NOT EXISTS`
  - Enum creation: 4 separate DO-blocks with `IF NOT EXISTS` pg_type check
  - Every policy uses `DROP POLICY IF EXISTS X ON Y; CREATE POLICY X ON Y ...`
  - Transaction wrap `BEGIN; COMMIT;` means partial application is rolled back on failure.
  - **Score: 5/5** ✅ passes threshold.

### CP-R15 — Setup documentation (4 steps + disclaimer)
- **Type**: `rule`
- **Covers**: AC-18
- **Evidence**:
  - 4 steps: (1) Create Supabase project, (2) copy env + fill, (3) apply migration via editor or CLI, (4) enable auth provider ✅
  - Explicit disclaimer: "Migration created but not applied. RLS created but not fully tested against a live Supabase project." ✅
  - Result: **pass**

---

## Review History

### Review R1 (implementer self-review, 2026-09-16)
- **Result**: `pass`
- **Evidence**: All 15 checkpoints above pass. Two rubrics (CP-U1, CP-U2) both score 5/5 above their >=4 thresholds.
- **Blocked By**: N/A
- **Environment caveats reported**: Migration not applied to live project. RLS not runtime-tested. Supabase CLI not installed. These caveats are explicitly documented in `supabase/README.md` per AC-18 and do not block acceptance of this milestone, which defines the foundation but does not provision infrastructure.
- **Recommended next milestone**: Milestone 3 — Authentication UI flows, automatic profile creation trigger on `auth.users`, first admin/clinic bootstrap helper, and the minimal protected layout that actually instantiates the `supabase` client to verify end-to-end connection after the manual setup steps above are performed by the project owner.
