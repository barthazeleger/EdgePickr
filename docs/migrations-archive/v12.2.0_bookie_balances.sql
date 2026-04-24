-- EdgePickr v12.2.0 — Per-bookie bankroll tracking
-- Eén rij per (user, bookie). Balance-wijzigingen via bet-flow hooks:
--   writeBet(Open)      → balance -= inzet
--   updateBetOutcome(W) → balance += inzet*odds (payout)
--   updateBetOutcome(L) → balance ongewijzigd (stake was al afgetrokken)
--   deleteBet(Open)     → balance += inzet
--   deleteBet(W)        → balance -= winst
--   deleteBet(L)        → balance += inzet
--
-- Negatieve balans is toegestaan (edge case: oude bets die niet via hooks
-- zijn gelogd). User corrigeert handmatig via PUT /api/bookie-balances/:bookie.

create table if not exists public.bookie_balances (
  id          bigserial primary key,
  user_id     uuid references public.users(id) on delete cascade,
  bookie      text not null,
  balance     numeric(10,2) not null default 0,
  updated_at  timestamptz not null default now(),
  unique (user_id, bookie)
);

create index if not exists bookie_balances_user_idx on public.bookie_balances(user_id);

alter table public.bookie_balances enable row level security;
do $$ begin
  create policy "srv_bookie_balances"
    on public.bookie_balances
    for all to service_role
    using (true) with check (true);
exception when duplicate_object then null; end $$;
