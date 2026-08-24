-- Archive opens to admins; the month's money stays with the owner.
--
-- Rio is an admin and is the person back-correcting past orders, so locking
-- the month browser to the owner locked out its main user. Access widens to
-- role = 'admin'; the revenue SUMMARY does not.
--
-- The line drawn here is "no revenue summary", not "no numbers". Per-order
-- totals stay visible on the cards — Rio already sees those in the live queue
-- and in the date-range window, and cannot correct an order he can't read.
-- What he doesn't get is gross/discounts/net per month, which is a report he
-- didn't have yesterday.
--
-- Nulled IN SQL, not hidden in the page. A CSS or JS hide is not a gate: the
-- payload sits in the network tab, and this is the owner's revenue. Same
-- reasoning as the anon revoke below — the visible lock and the real lock have
-- to be the same lock.
--
-- plpgsql rather than sql so the caller is resolved once, into two flags,
-- instead of a subquery per money column.

create or replace function public.orders_months()
returns table (
  month        text,      -- 'YYYY-MM' in PH time
  n            int,
  cancelled    int,
  gross        numeric,   -- NULL for non-owner admins
  discounts    numeric,   -- NULL for non-owner admins
  net          numeric,   -- NULL for non-owner admins
  dining       int,
  room_service int,
  pay_cash     int,
  pay_gcash    int,
  pay_card     int,
  pay_room     int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin boolean := false;
  v_owner boolean := false;
begin
  select (s.role = 'admin'), coalesce(s.is_prime, false)
    into v_admin, v_owner
    from public.staff s
   where s.auth_uid = auth.uid() and s.is_active;

  -- Not an active admin: no rows at all, exactly as before.
  if not coalesce(v_admin, false) then
    return;
  end if;

  return query
  select
    to_char(o.created_at at time zone 'Asia/Manila', 'YYYY-MM'),
    count(*)::int,
    count(*) filter (where o.status = 'cancelled')::int,
    -- Cancelled orders are counted above but are NOT revenue, so every money
    -- figure excludes them.
    case when v_owner then coalesce(sum(o.total)
           filter (where o.status <> 'cancelled'), 0) end,
    case when v_owner then coalesce(sum(coalesce(o.discount_amount, 0))
           filter (where o.status <> 'cancelled'), 0) end,
    case when v_owner then coalesce(sum(o.total - coalesce(o.discount_amount, 0))
           filter (where o.status <> 'cancelled'), 0) end,
    -- Counts, not money: these are how you find an order, and an admin who
    -- can already open every card can already count them by hand.
    count(*) filter (where o.is_dining_in)::int,
    count(*) filter (where not o.is_dining_in)::int,
    count(*) filter (where o.payment_intent = 'cash')::int,
    count(*) filter (where o.payment_intent = 'gcash')::int,
    count(*) filter (where o.payment_intent = 'card')::int,
    count(*) filter (where o.payment_intent = 'room')::int
  from public.orders o
  group by 1
  order by 1 desc;
end;
$$;

-- Unchanged from db/031, and still necessary: revoking from PUBLIC does NOT
-- stop anon on Supabase — default privileges grant EXECUTE to anon by name at
-- creation, and CREATE OR REPLACE re-applies them. Re-run every time.
revoke all on function public.orders_months() from public;
revoke all on function public.orders_months() from anon;
grant execute on function public.orders_months() to authenticated;
