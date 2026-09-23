const get = (key: `VITE_${string}`): string | null => {
  const raw = import.meta.env[key]
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  return null
}

export const env = {
  SUPABASE_URL: get('VITE_SUPABASE_URL'),
  SUPABASE_PUBLISHABLE_KEY: get('VITE_SUPABASE_PUBLISHABLE_KEY'),
} as const

export type Env = typeof env
