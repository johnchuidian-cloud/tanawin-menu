-- Orders by month — the archive Lexi asked for.
--
-- Aggregated in SQL, ONE ROW PER MONTH. A few dozen rows however big the
-- table gets, so it can never be truncated by PostgREST's row cap and needs
-- no paging. The alternative — select everything and count in JS — is the
-- exact shape that silently under-reports once the table outgrows the cap,
-- and it under-reports without any error to notice.
--
-- Months are cut in Asia/Manila, NOT UTC. PH is UTC+8, so a UTC boundary
-- files every order placed before 8am on the 1st under the previous month —
-- which would quietly move real money between months.
--
-- MONEY DEFINITION, so the page and the export agree:
--   cancelled orders are counted but contribute NOTHING to gross/discounts/
--   net. A cancelled order is not revenue. `n` is every order raised in the
--   month, `cancelled` is how many of those were cancelled.
--
-- Nothing moves. "Archive" is a read view over rows that stay in `orders` —
-- no archive table, no purge. Storage is free at this scale and a purge is
-- how history gets lost.

create or replace function public.orders_months()
returns table (
  month        text,      -- 'YYYY-MM' in PH time
  n            int,
  cancelled    int,
  gross        numeric,
  discounts    numeric,
  net          numeric,
  dining       int,
  room_service int,
  pay_cash     int,
  pay_gcash    int,
  pay_card     int,
  pay_room     int
)
language sql
security definer
set search_path = public
as $$
  select
    to_char(o.created_at at time zone 'Asia/Manila', 'YYYY-MM') as month,
    count(*)::int,
    count(*) filter (where o.status = 'cancelled')::int,
    coalesce(sum(o.total)                        filter (where o.status <> 'cancelled'), 0),
    coalesce(sum(coalesce(o.discount_amount, 0)) filter (where o.status <> 'cancelled'), 0),
    coalesce(sum(o.total - coalesce(o.discount_amount, 0))
                                                 filter (where o.status <> 'cancelled'), 0),
    count(*) filter (where o.is_dining_in)::int,
    count(*) filter (where not o.is_dining_in)::int,
    count(*) filter (where o.payment_intent = 'cash')::int,
    count(*) filter (where o.payment_intent = 'gcash')::int,
    count(*) filter (where o.payment_intent = 'card')::int,
    count(*) filter (where o.payment_intent = 'room')::int
  from public.orders o
  -- Owner only, on John's instruction — stricter than admin, because Rio and
  -- Monique are admins too. security definer, so the gate lives here rather
  -- than in RLS. is_prime is the existing owner flag (db/012); a hardcoded
  -- slug would break the day Lexi's account is ever recreated.
  where exists (
    select 1 from public.staff s
     where s.auth_uid = auth.uid() and s.is_prime and s.is_active
  )
  group by 1
  order by 1 desc;
$$;

-- ⚠️ Revoking from PUBLIC is NOT enough on Supabase: its default privileges
-- grant EXECUTE to anon/authenticated/service_role BY NAME the moment a
-- function is created, and a PUBLIC revoke leaves those named grants intact.
-- Without the explicit anon revoke this returns 200 [] to a raw anon call
-- instead of refusing it. The in-body owner check is the first lock; this is
-- the second. (Concierge hit this on 2026-08-24 and passed the warning on.)
revoke all on function public.orders_months() from public;
revoke all on function public.orders_months() from anon;
grant execute on function public.orders_months() to authenticated;
