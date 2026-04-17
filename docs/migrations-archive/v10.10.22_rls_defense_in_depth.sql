-- EdgePickr v10.10.22 — RLS defense-in-depth
-- Alle tabellen: RLS enabled + service_role policy.

alter table public.bets enable row level security;
alter table public.users enable row level security;
alter table public.fixtures enable row level security;
alter table public.odds_snapshots enable row level security;
alter table public.feature_snapshots enable row level security;
alter table public.market_consensus enable row level security;
alter table public.model_versions enable row level security;
alter table public.model_runs enable row level security;
alter table public.pick_candidates enable row level security;
alter table public.signal_stats enable row level security;
alter table public.signal_calibration enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.scan_history enable row level security;
alter table public.calibration enable row level security;
alter table public.execution_logs enable row level security;
alter table public.training_examples enable row level security;
alter table public.raw_api_events enable row level security;

do $$ begin create policy "srv_bets" on public.bets for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_users" on public.users for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_fixtures" on public.fixtures for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_odds_snapshots" on public.odds_snapshots for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_feature_snapshots" on public.feature_snapshots for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_market_consensus" on public.market_consensus for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_model_versions" on public.model_versions for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_model_runs" on public.model_runs for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_pick_candidates" on public.pick_candidates for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_signal_stats" on public.signal_stats for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_signal_calibration" on public.signal_calibration for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_notifications" on public.notifications for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_push_subscriptions" on public.push_subscriptions for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_scan_history" on public.scan_history for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_calibration" on public.calibration for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_execution_logs" on public.execution_logs for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_training_examples" on public.training_examples for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "srv_raw_api_events" on public.raw_api_events for all to service_role using (true) with check (true); exception when duplicate_object then null; end $$;
