# Milestone 0028 — review and manual verification

## Prerequisites and scope

Apply nothing automatically. Review the full `0028_owner_controlled_clinics.sql`
in the intended project after migrations 0001–0027. Confirm there is no schema
drift in the 20 replaced business RPCs, no `platform_owners` table or
`lifecycle_status` column, and no same-named functions/policies/triggers from a
partial prior installation. Run as the database administrative owner. Take the
normal database backup and arrange a maintenance window for ALTER TABLE locks.

Existing clinics are backfilled active; new clinics default pending. No existing
membership, patient, appointment, clinical record, invoice or payment is updated
or deleted. The owner registry is separate from clinic roles. Registry ownership
does not grant clinical read access. Owner creation assigns an existing confirmed
Auth account with no clinic membership; it does not create an Auth account or
send invitation mail. This preserves the existing one-clinic onboarding model.

All 20 business SECURITY DEFINER RPCs retain their previous bodies except an
entry guard. The guard takes a clinic UPDATE lock before downstream locks:
operations within one clinic serialize, including procedure reports. Suspension
waits for earlier operations; operations ordered after suspension fail. This is
a deliberate conservative throughput tradeoff. Direct tenant mutations have
additional row triggers; RLS also denies reads/writes while inactive. In-flight
reads may finish with their existing statement snapshot. Data already delivered
to a browser cannot be revoked retroactively.

The UI rechecks access every 15 seconds and on focus, unmounting the clinic
workspace on suspension, inactive membership or verification failure. Database
enforcement does not wait for polling. Pending/suspended users can inspect only
their own access-status metadata using `my_clinic_access`. Their Auth session is
not globally disabled. Platform Owners use a metadata-only management console.

## Register the initial Platform Owner — separately in each project

1. In **Development** Supabase, create/invite the intended owner using the Auth
   dashboard. Complete confirmation and set a strong password; enable MFA for
   the account where supported. Verify the identity out of band and copy its
   immutable **Auth user UUID**, not its email or any access token.
2. After a separately authorized application of 0028, open that project's SQL
   Editor as `postgres`. Confirm the project reference/dashboard is Development.
   Replace the single UUID placeholder below and run the complete transaction.
3. Sign in to the application with that account. The owner console must load;
   an ordinary clinic admin must not be able to load it by direct RPC calls.
4. For **Production**, repeat the same steps only after explicit Production
   release authorization, using the separately verified Production Auth UUID.
   Never reuse a Development UUID without verifying the actual Production Auth
   identity. No Production action is performed by this local milestone.

```sql
BEGIN;
DO $register$
DECLARE owner_id uuid := 'REPLACE_WITH_THIS_PROJECTS_VERIFIED_OWNER_AUTH_UUID';
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Administrative SQL Editor role required'; END IF;
  PERFORM 1 FROM auth.users
  WHERE id=owner_id AND email_confirmed_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Verified confirmed Auth account required'; END IF;
  INSERT INTO public.profiles(id) VALUES(owner_id) ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.platform_owners(user_id) VALUES(owner_id) ON CONFLICT(user_id) DO NOTHING;
END;
$register$;
COMMIT;
```

No secret/service key belongs in React, environment exports, screenshots or this
script. The registry has RLS enabled and no client/service-role grants or write
policies. There is intentionally no self-enrolment or owner-management RPC.
Owner removal/recovery requires the administrative SQL Editor and a separately
verified UUID; never grant access based on a frontend email check or editable
user metadata. Restrict dashboard/database administrator access accordingly.

For each initial clinic administrator, use the Auth dashboard to create/invite
and confirm an account first; verify its UUID and ensure it has no existing
membership. In the owner console create the pending clinic with that UUID, then
activate it. Subsequent staff invitations remain the clinic admin's workflow.

## Verification

Run local source checks with:

```powershell
node --test supabase/tests/0028_source_regression.test.mjs
```

These check coverage and preservation of prior RPC bodies; they do not execute
PostgreSQL. In Development only, after authorized migration application, run the
entire `0028_owner_controlled_clinics_test.sql` as postgres. Configure three
distinct, authorized synthetic confirmed Auth identities with profiles. Admin
and outsider must have no memberships. Only newly generated clinics and their
records are mutated. Expected result: PASS, 29 checks, fixture rollback. The
script exercises non-owner direct RPCs, bootstrap/registry denial, pending access,
tenant isolation, direct status-change denial, patient/invoice/payment flow,
suspended access with the same authenticated identity, trusted staff provisioning
denial, history preservation and reactivation. It also checks ordinary active-admin
settings and currency updates, suspended settings denial, and trigger enforcement
for lifecycle/settings writes through the RLS-bypassing service role. It is not a migration.

If any run stops before ROLLBACK, roll back in that same session or close it.
Unexpected errors produce FAIL (SQLSTATE only); never report a partial run as
passing. Do not run synthetic tests in Production. Optional sequence gaps from
database sequences are not business data changes.

Still requires live verification:

- Run the Development SQL harness and existing clinical/0027 regressions. Clinical
  bodies are source-checked, but every suspended clinical RPC path has not been
  exercised at runtime by this milestone's harness.
- Independently test suspension versus a concurrent payment/consultation/booking
  in two sessions. Confirm a prior operation finishes before suspension and a
  later operation is denied. No concurrency PASS is claimed locally.
- Review/deploy the changed invite-staff function only under separate deployment
  authorization. Verify inactive clinics send no invitation in normal operation
  and concurrent suspension cannot provision membership. An external invitation
  email can race with suspension between the Edge precheck and the mail API;
  final database provisioning is guarded and cannot grant suspended access.
- Browser-check owner creation, pending/active/suspended/reactivated screens,
  ordinary admin invitations, existing open-session polling/focus and sign-out.
- Supabase service-role/dashboard administrators inherently bypass RLS; these
  credentials are trusted infrastructure, never distributed to browser users.
  Unknown deployed RPCs, integrations or Storage policies outside repository
  migrations require a live inventory before release. Future definer RPCs must
  explicitly call require_active_clinic and retain role/tenant authorization.

Local implementation does not apply SQL, change Auth identities, register an
owner, deploy the Edge Function/UI, or alter Production.
