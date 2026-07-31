# Atlas Supabase Setup

1. In the Supabase dashboard, open `SQL Editor` and choose `New query`.
2. Paste and run `migrations/20260731_atlas_profiles.sql`.
3. In `Authentication > URL Configuration`, add the production callback URL before enabling email confirmations or OAuth.

The migration enables RLS on every Atlas table. The publishable key is sufficient for the desktop client; `SUPABASE_SERVICE_ROLE_KEY` must only be used by a future deployed crawler/API service and must never be packaged into Electron.
