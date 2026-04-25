-- EdgePickr v12.2.9 — auth_codes persistent 2FA store
-- F6 fix: 2FA login-codes leefden alleen in-memory Map. Bij Render-restart
-- (deploy, crash, free-tier spindown) werden actieve 2FA-sessies stuk —
-- gebruiker moest opnieuw inloggen + nieuwe code aanvragen. Persisteer naar
-- Supabase met TTL-cleanup zodat een running scheduled cleanup oude rows
-- wist. Plain-text storage (geen hash) — code is 6 digits, korte TTL,
-- service_role RLS sluit externe access af.

create table if not exists public.auth_codes (
  email_key  text primary key,
  code       text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists auth_codes_expires_idx on public.auth_codes(expires_at);

alter table public.auth_codes enable row level security;

do $$ begin
  create policy "srv_auth_codes"
    on public.auth_codes
    for all to service_role
    using (true) with check (true);
exception when duplicate_object then null; end $$;
