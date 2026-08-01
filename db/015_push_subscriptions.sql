-- Web push subscriptions, one row per staff device (a phone can hold several
-- if the same person installs on two browsers). The endpoint URL IS the
-- address the push service delivers to, so it's the natural primary key.
--
-- Rows are written by the staff dashboard under the signed-in user's JWT and
-- read only by the order-push Edge Function (service role), which also deletes
-- rows the push service reports as gone (404/410).

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  auth_uid uuid,                       -- who subscribed (for the Staff-tab list)
  staff_name text,                     -- snapshot, survives a staff-row rename
  created_at timestamptz default now(),
  last_success_at timestamptz
);

alter table public.push_subscriptions enable row level security;

-- Staff manage their own device rows; nobody anonymous touches this table.
create policy "staff insert own subscription" on public.push_subscriptions
  for insert to authenticated with check (auth_uid = auth.uid());
create policy "staff read own subscription" on public.push_subscriptions
  for select to authenticated using (auth_uid = auth.uid());
create policy "staff update own subscription" on public.push_subscriptions
  for update to authenticated using (auth_uid = auth.uid());
create policy "staff delete own subscription" on public.push_subscriptions
  for delete to authenticated using (auth_uid = auth.uid());
