-- EdgePickr v12.2.14 — D1: persistent scheduled jobs
--
-- Probleem: schedulePreKickoffCheck + scheduleCLVCheck gebruiken in-memory
-- setTimeout. Bij Render free-tier spindown / crash / deploy gaan pending
-- timers verloren. Pre-kickoff drift-alert en CLV-snapshot worden gemist.
--
-- Fix: persisteer jobs naar DB met due_at. setTimeout blijft voor low-latency
-- firing, DB als source-of-truth. Bij boot: rescheduleer pending jobs.
-- Sweep job elke 10 min ruimt completed > 7 dagen op.
--
-- Job-execution moet idempotent zijn (job kan dubbele keer draaien bij
-- race tussen setTimeout-fire en boot-rescan). Pre-kickoff en CLV-check
-- zijn beide idempotent: API-fetch + notify, geen state-mutatie.

create table if not exists public.scheduled_jobs (
  id            bigserial primary key,
  user_id       uuid references public.users(id) on delete cascade,
  job_type      text not null,                -- 'pre_kickoff' | 'clv_check'
  bet_id        bigint,                       -- voor join met bets
  payload       jsonb not null default '{}',  -- bet snapshot voor execution
  due_at        timestamptz not null,
  attempts      int not null default 0,
  last_error    text,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists scheduled_jobs_due_idx
  on public.scheduled_jobs(due_at)
  where completed_at is null;

create index if not exists scheduled_jobs_bet_type_idx
  on public.scheduled_jobs(bet_id, job_type);

alter table public.scheduled_jobs enable row level security;

do $$ begin
  create policy "srv_scheduled_jobs"
    on public.scheduled_jobs
    for all to service_role
    using (true) with check (true);
exception when duplicate_object then null; end $$;
