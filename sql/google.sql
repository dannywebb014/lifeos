-- google_tokens: each person's Google Calendar refresh token, for the
-- google-auth function (lifeos/supabase/functions/google-auth), so the apps
-- stay connected to Google without a trip there every hour.
-- The token is encrypted by the function (a key only it has), and no
-- browser can read or write this table: row-level security is on with no
-- policies, so only the server (service role) reaches it.
-- Run once in the Supabase SQL editor (project myhub.). Safe to run again.

create table if not exists public.google_tokens (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  refresh_token  text not null,
  email          text,
  scope          text,
  updated_at     timestamptz not null default now()
);
alter table public.google_tokens enable row level security;
revoke all on public.google_tokens from anon, authenticated;
