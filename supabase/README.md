# Supabase — Manual Setup Instructions

This milestone creates the database schema as reproducible migration files.
The migration has been applied to the configured Supabase project. Row Level
Security policies have **NOT been tested** against a running instance.

## Required manual steps

1. **Create a Supabase project.**
   Go to https://supabase.com/dashboard and create a new project for your
   clinic tenant (or multi-tenant staging instance).  Retain the Project
   Ref / URL and the anon / **publishable** key from
   *Project Settings → API*.

2. **Configure environment variables locally.**
   Copy the template `.env.example` at the repository root to `.env`:

   ```
   cp .env.example .env
   ```

   then fill in the two values from step 1:

   ```
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=eyJhbGciOi...(anon/publishable key, NOT service_role)
   ```

   Never commit the `.env` file.  It is already ignored by `.gitignore`.
   Never place the `service_role` key in any frontend file — it must be
   used only from secure server-side code and never shipped to browsers.

3. **Apply the database migration.**
   Run the contents of `supabase/migrations/0001_initial_schema.sql`
   inside the Supabase *SQL Editor* for your project, or install the
   Supabase CLI and run:

   ```
   supabase link --project-ref <project-ref>
   supabase db push
   ```

   (The CLI is **not installed** as part of this milestone — the
   schema must be applied manually for now.)

4. **Enable your authentication provider(s).**
   In the Supabase dashboard open *Authentication → Providers* and
   enable at least **Email / Password** (or your chosen provider, e.g.
   Phone, Magic Link).  Auth UI flows are deferred to a later milestone;
   this step is required so that `auth.users` rows can exist when
   clinic memberships are populated.

## Status

- [x] Migration created: `supabase/migrations/0001_initial_schema.sql`
- [x] Migration applied.
- [ ] RLS verified end-to-end with a live test session.

Migration applied. RLS created but not fully tested against a live Supabase
project.
