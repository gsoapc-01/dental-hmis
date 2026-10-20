// Source regression checks; database authorization requires the separate SQL test.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (p) => readFileSync(root + p, 'utf8')
const migration = read('supabase/migrations/0028_owner_controlled_clinics.sql')
const functions = (source) => [...source.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.(\w+)\s*\([\s\S]*?\bAS\s+(\$\w*\$)([\s\S]*?)\2\s*;/gi)]
const prior = new Map()
for (const f of readdirSync(root + 'supabase/migrations').filter((f) => /^00(0[1-9]|1\d|2[0-7])_/.test(f)).sort()) {
  for (const m of functions(read('supabase/migrations/' + f))) prior.set(m[1], m)
}
const current = new Map(functions(migration).map((m) => [m[1], m]))
const guarded = ['admin_change_clinic_staff_role','admin_set_clinic_staff_active','update_clinic_currency',
  'provision_clinic_staff_membership','start_encounter_context','book_encounter_appointment',
  'start_consultation','exit_appointment_queue','save_consultation','complete_consultation',
  'finalize_standalone_visit','create_invoice','record_payment','update_patient_clinical_profile',
  'manage_procedure_catalog','install_dental_procedure_template','record_performed_procedure',
  'procedure_activity_report','correct_dental_chart_entry','correct_clinical_record']
test('all 20 guarded RPCs retain their previous bodies except the lifecycle guard', () => {
  for (const name of guarded) {
    assert.ok(current.has(name), name)
    const body = current.get(name)[3]
    assert.match(body, /BEGIN\s+PERFORM public\.require_active_clinic\(/i, name)
    const lines = body.split(/\r?\n/).filter((line) => !line.trim().startsWith('PERFORM public.require_active_clinic(')).join('\n')
    assert.equal(lines, prior.get(name)[3].replaceAll('\r\n', '\n'), name)
  }
})
test('no exposed legacy business SECURITY DEFINER RPC is left unguarded', () => {
  for (const [name, m] of prior) {
    if (!/SECURITY DEFINER/i.test(m[0]) || /RETURNS\s+trigger/i.test(m[0])) continue
    assert.ok(guarded.includes(name) || ['bootstrap_clinic','is_clinic_member','is_clinic_member_as','is_clinic_staff'].includes(name), name)
  }
})
test('public setup removed; invitation checks clinic lifecycle before sending email', () => {
  const app = read('src/App.tsx')
  assert.doesNotMatch(app, /ClinicSetupScreen|rpc\('bootstrap_clinic'/)
  assert.match(app, /my_clinic_access/)
  const invite = read('supabase/functions/invite-staff/index.ts')
  const check = invite.indexOf('clinic?.lifecycle_status !== "active"')
  assert.ok(check > 0 && check < invite.indexOf('adminClient.auth.admin.inviteUserByEmail'))
})
test('registry and old creation path are closed; default changes after active backfill', () => {
  assert.match(migration, /REVOKE ALL ON public\.platform_owners FROM PUBLIC, anon, authenticated, service_role/)
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.bootstrap_clinic\(text\) FROM PUBLIC,anon,authenticated,service_role/)
  assert.ok(migration.indexOf("DEFAULT 'active'") < migration.indexOf("SET DEFAULT 'pending'"))
})

test('clinic row trigger enforces owner authorization independently of RLS', () => {
  const guard = current.get('guard_clinic_lifecycle')[3]
  assert.match(guard, /TG_OP='INSERT' OR NEW\.lifecycle_status IS DISTINCT FROM OLD\.lifecycle_status/)
  assert.match(guard, /IF NOT public\.is_platform_owner\(\) THEN\s+RAISE EXCEPTION[^;]+ERRCODE='42501'/)
  assert.match(guard, /ELSE\s+PERFORM public\.require_active_clinic\(OLD\.id\)/)
  assert.match(migration, /BEFORE INSERT OR UPDATE ON public\.clinics\s+FOR EACH ROW EXECUTE FUNCTION public\.guard_clinic_lifecycle\(\)/)
  assert.match(current.get('is_platform_owner')[3], /public\.platform_owners WHERE user_id=auth\.uid\(\)/)
})

test('ordinary clinic settings retain the active-admin policy and currency RPC', () => {
  const policies = read('supabase/migrations/0003_security_reconciliation.sql')
  assert.match(policies, /CREATE POLICY clinics_admin_update\s+ON public\.clinics\s+FOR UPDATE\s+TO authenticated\s+USING\s*\(\s*public\.is_clinic_member_as\([\s\S]*?WITH CHECK\s*\(\s*public\.is_clinic_member_as\(/)
  assert.match(current.get('is_clinic_member_as')[3], /public\.clinic_is_active\(p_clinic_id\) AND EXISTS/)
  assert.doesNotMatch(migration, /REVOKE\s+(?:ALL|UPDATE)\s+ON\s+(?:TABLE\s+)?public\.clinics/i)
  assert.match(current.get('owner_set_clinic_status')[3], /IF NOT public\.is_platform_owner\(\)/)
  assert.match(current.get('owner_create_clinic')[3], /IF NOT public\.is_platform_owner\(\)/)
})
