import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type ManagedClinic = { id: string; name: string; lifecycle_status: 'pending' | 'active' | 'suspended'; created_at: string }
export type ClinicAccess = { clinic_id: string; lifecycle_status: ManagedClinic['lifecycle_status']; is_active: boolean }
type LifecycleDatabase = { public: {
  Tables: Record<string, never>; Views: Record<string, never>
  Functions: {
    is_platform_owner: { Args: Record<string, never>; Returns: boolean }
    owner_list_clinics: { Args: Record<string, never>; Returns: ManagedClinic[] }
    owner_create_clinic: { Args: { p_name: string; p_admin_user_id: string }; Returns: ManagedClinic }
    owner_set_clinic_status: { Args: { p_clinic_id: string; p_status: string }; Returns: ManagedClinic }
    my_clinic_access: { Args: Record<string, never>; Returns: ClinicAccess[] }
  }
} }
export const lifecycleClient = supabase as unknown as SupabaseClient<LifecycleDatabase> | null
