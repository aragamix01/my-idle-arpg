-- Run this in the Supabase SQL editor after creating the project.
--
-- Also enable anonymous sign-ins: Authentication -> Sign In / Providers ->
-- "Allow anonymous sign-ins". Without it, players hit a login wall on first
-- visit, which is what the anonymous-first identity model exists to avoid.

create table if not exists public.players (
  -- Same id as auth.users. An anonymous user is a real row in auth.users, so
  -- linking a Discord/Google account later keeps this id and the save with it.
  id uuid primary key references auth.users (id) on delete cascade,

  -- The authoritative SaveState blob, written only by the server.
  save jsonb not null,

  -- Denormalised out of `save` so the server can compute offline progress and
  -- rank leaderboards without parsing every blob.
  content_version integer not null,
  best_stage integer not null default 0,
  last_seen_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Leaderboards, later. Cheap to add now, awkward to add to a large table.
create index if not exists players_best_stage_idx
  on public.players (best_stage desc);

alter table public.players enable row level security;

-- Players may READ their own save. That is the entire client-side grant.
--
-- There is deliberately no INSERT, UPDATE or DELETE policy. With RLS enabled
-- and no matching policy, those operations are denied for anyone using the
-- publishable key - including the player themselves.
--
-- All writes go through the /api/command route handler using SUPABASE_SECRET_KEY,
-- which bypasses RLS. That handler runs applyCommand first, so every mutation is
-- validated against the game rules. If players could UPDATE this table directly,
-- the command layer would be decoration and gold would be a text field.
drop policy if exists "players read own save" on public.players;
create policy "players read own save"
  on public.players
  for select
  to authenticated
  using ((select auth.uid()) = id);

-- Keep updated_at honest without trusting callers to set it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists players_touch_updated_at on public.players;
create trigger players_touch_updated_at
  before update on public.players
  for each row
  execute function public.touch_updated_at();
