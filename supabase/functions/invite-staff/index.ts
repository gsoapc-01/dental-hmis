import { createClient, type User } from "npm:@supabase/supabase-js@2"

type StaffRole = "admin" | "doctor" | "receptionist"
type MembershipSummary = { clinic_id: string }
type ExistingUserLookup =
  | { ok: true; user: User | null }
  | { ok: false }

const localViteOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
])
const staffRoles = new Set<StaffRole>(["admin", "doctor", "receptionist"])
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const authUsersPerPage = 1000

function configuredOrigins() {
  return (Deno.env.get("INVITE_STAFF_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => {
      if (!value) return false
      try {
        const parsed = new URL(value)
        return parsed.origin === value && parsed.protocol === "https:"
      } catch {
        return false
      }
    })
}

function isAllowedOrigin(origin: string) {
  if (localViteOrigins.has(origin)) return true
  return configuredOrigins().includes(origin)
}

function corsHeaders(origin: string | null) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  })
  if (origin && isAllowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin)
  }
  return headers
}

function jsonResponse(status: number, body: Record<string, string>, origin: string | null) {
  const headers = corsHeaders(origin)
  headers.set("Content-Type", "application/json; charset=utf-8")
  return new Response(JSON.stringify(body), { status, headers })
}

function getServerApiKey() {
  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS")
  if (!secretKeysJson) return null
  try {
    const secretKeys = JSON.parse(secretKeysJson) as Record<string, unknown>
    const defaultSecretKey = secretKeys["default"]
    return typeof defaultSecretKey === "string" && defaultSecretKey.length > 0
      ? defaultSecretKey
      : null
  } catch {
    return null
  }
}

async function findAuthUserByEmail(adminClient: ReturnType<typeof createClient>, email: string): Promise<ExistingUserLookup> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: authUsersPerPage })
    if (error) return { ok: false }

    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email)
    if (user) return { ok: true, user }
    if (data.users.length < authUsersPerPage) return { ok: true, user: null }
  }
}

async function getUserMemberships(adminClient: ReturnType<typeof createClient>, userId: string) {
  return await adminClient
    .from("clinic_memberships")
    .select("clinic_id")
    .eq("user_id", userId)
}

async function provisionMembership(
  adminClient: ReturnType<typeof createClient>,
  clinicId: string,
  userId: string,
  displayName: string,
  role: StaffRole,
) {
  return await adminClient.rpc("provision_clinic_staff_membership", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_display_name: displayName,
    p_role: role,
  } as never)
}

function parseRequestBody(value: unknown): { clinicId: string; email: string; displayName: string; role: StaffRole } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (typeof body.clinic_id !== "string" || !uuidPattern.test(body.clinic_id)) return null
  if (typeof body.email !== "string") return null
  const email = body.email.trim().toLowerCase()
  if (email.length > 254 || !emailPattern.test(email)) return null
  if (typeof body.display_name !== "string") return null
  const displayName = body.display_name.trim()
  if (
    displayName.length < 1
    || displayName.length > 120
    || /\p{Cc}/u.test(displayName)
  ) return null
  if (typeof body.role !== "string" || !staffRoles.has(body.role as StaffRole)) return null

  return { clinicId: body.clinic_id, email, displayName, role: body.role as StaffRole }
}

async function existingUserResponse(
  adminClient: ReturnType<typeof createClient>,
  user: User,
  clinicId: string,
  displayName: string,
  role: StaffRole,
  origin: string | null,
) {
  const { data: memberships, error } = await getUserMemberships(adminClient, user.id)
  if (error) {
    return jsonResponse(500, { error: "We could not verify this account's clinic memberships." }, origin)
  }

  const existingMemberships = (memberships ?? []) as MembershipSummary[]
  if (existingMemberships.some((membership) => membership.clinic_id === clinicId)) {
    return jsonResponse(409, { error: "This account already belongs to the requested clinic." }, origin)
  }
  if (existingMemberships.length > 0) {
    return jsonResponse(409, { error: "This account belongs to another clinic. Multi-clinic access is not available yet." }, origin)
  }

  if (!user.email_confirmed_at && !user.confirmed_at) {
    return jsonResponse(409, { error: "An unconfirmed account or invitation already exists for this email. No duplicate was created." }, origin)
  }

  const { error: provisioningError } = await provisionMembership(adminClient, clinicId, user.id, displayName, role)
  if (provisioningError) {
    const { data: membershipsAfterProvision, error: membershipCheckError } = await getUserMemberships(adminClient, user.id)
    if (!membershipCheckError) {
      const membershipsAfter = (membershipsAfterProvision ?? []) as MembershipSummary[]
      if (membershipsAfter.some((membership) => membership.clinic_id === clinicId)) {
        return jsonResponse(409, { error: "This account already belongs to the requested clinic." }, origin)
      }
      if (membershipsAfter.length > 0) {
        return jsonResponse(409, { error: "This account belongs to another clinic. Multi-clinic access is not available yet." }, origin)
      }
    }
    return jsonResponse(500, { error: "We could not add this account to the clinic." }, origin)
  }

  return jsonResponse(200, { message: "Staff access was added. They can sign in with their existing account." }, origin)
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin")
  if (origin && !isAllowedOrigin(origin)) {
    return jsonResponse(403, { error: "This origin is not allowed." }, null)
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) })
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Only POST and OPTIONS are supported." }, origin)
  }

  const authorization = request.headers.get("authorization")
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!bearer) {
    return jsonResponse(401, { error: "A valid sign-in session is required." }, origin)
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const serviceRoleKey = getServerApiKey()
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("invite-staff: required Supabase runtime configuration is missing")
    return jsonResponse(500, { error: "Staff invitations are temporarily unavailable." }, origin)
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })

  try {
    const { data: authData, error: authError } = await adminClient.auth.getUser(bearer)
    if (authError || !authData.user) {
      return jsonResponse(401, { error: "The sign-in session is invalid or expired." }, origin)
    }

    let bodyValue: unknown
    try {
      bodyValue = await request.json()
    } catch {
      return jsonResponse(400, { error: "A valid JSON request body is required." }, origin)
    }
    const payload = parseRequestBody(bodyValue)
    if (!payload) {
      return jsonResponse(400, { error: "Provide a valid clinic, email, display name, and supported staff role." }, origin)
    }

    const { data: callerMembership, error: membershipError } = await adminClient
      .from("clinic_memberships")
      .select("role, is_active")
      .eq("clinic_id", payload.clinicId)
      .eq("user_id", authData.user.id)
      .maybeSingle()
    if (membershipError) {
      console.error("invite-staff: caller membership verification failed")
      return jsonResponse(500, { error: "We could not verify clinic administrator access." }, origin)
    }
    if (callerMembership?.role !== "admin" || callerMembership.is_active !== true) {
      return jsonResponse(403, { error: "An active administrator membership in this clinic is required." }, origin)
    }

    const authLookup = await findAuthUserByEmail(adminClient, payload.email)
    if (!authLookup.ok) {
      console.error("invite-staff: Auth user lookup failed")
      return jsonResponse(500, { error: "We could not check whether this email already has an account." }, origin)
    }

    if (authLookup.user) {
      return await existingUserResponse(
        adminClient,
        authLookup.user,
        payload.clinicId,
        payload.displayName,
        payload.role,
        origin,
      )
    }

    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(payload.email)
    if (inviteError || !inviteData.user) {
      const racedAuthLookup = await findAuthUserByEmail(adminClient, payload.email)
      if (!racedAuthLookup.ok) {
        console.error("invite-staff: post-invite Auth lookup failed")
        return jsonResponse(500, { error: "We could not safely complete this invitation." }, origin)
      }
      if (racedAuthLookup.user) {
        return await existingUserResponse(
          adminClient,
          racedAuthLookup.user,
          payload.clinicId,
          payload.displayName,
          payload.role,
          origin,
        )
      }
      console.error("invite-staff: Auth invitation failed")
      return jsonResponse(502, { error: "Supabase could not send the invitation email." }, origin)
    }

    const newAuthUserId = inviteData.user.id
    let provisioningFailed = false
    try {
      const { error: provisioningError } = await provisionMembership(
        adminClient,
        payload.clinicId,
        newAuthUserId,
        payload.displayName,
        payload.role,
      )
      provisioningFailed = Boolean(provisioningError)
    } catch {
      provisioningFailed = true
    }

    if (provisioningFailed) {
      const { data: membershipsAfterProvision, error: membershipCheckError } = await getUserMemberships(adminClient, newAuthUserId)
      if (!membershipCheckError && (membershipsAfterProvision ?? []).length > 0) {
        const hasRequestedClinic = (membershipsAfterProvision as MembershipSummary[])
          .some((membership) => membership.clinic_id === payload.clinicId)
        if (hasRequestedClinic) {
          return jsonResponse(409, { error: "This account was provisioned concurrently. Review its staff membership before retrying." }, origin)
        }
        return jsonResponse(409, { error: "The account now belongs to another clinic and was not modified." }, origin)
      }

      if (membershipCheckError) {
        console.error("invite-staff: provisioning failed and membership cleanup check failed")
        return jsonResponse(500, { error: "Invitation setup failed. Contact support before retrying." }, origin)
      }

      try {
        const { error: cleanupError } = await adminClient.auth.admin.deleteUser(newAuthUserId)
        if (cleanupError) {
          console.error("invite-staff: cleanup of newly invited Auth user failed")
          return jsonResponse(500, { error: "Invitation setup failed. Contact support before retrying." }, origin)
        }
      } catch {
        console.error("invite-staff: cleanup of newly invited Auth user failed")
        return jsonResponse(500, { error: "Invitation setup failed. Contact support before retrying." }, origin)
      }

      console.error("invite-staff: database provisioning failed; newly invited Auth user was removed")
      return jsonResponse(500, { error: "Staff provisioning failed. The new invitation account was cleaned up." }, origin)
    }

    return jsonResponse(201, { message: "Invitation sent and staff membership provisioned." }, origin)
  } catch {
    console.error("invite-staff: unexpected server failure")
    return jsonResponse(500, { error: "Staff invitation failed unexpectedly." }, origin)
  }
})
