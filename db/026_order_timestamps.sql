-- When each step of an order actually happened.
--
-- Until now the only time on an order was created_at. handled_by records WHO
-- carried it and never when, so "how long did that table wait?" had no answer
-- anywhere in the system — the one question you'd want to ask after a slow
-- night. Guest requests have had acknowledged_at/done_at since Concierge
-- phase 2; orders never got the equivalent.
--
-- Three stamps rather than the two asked for, because the third costs nothing
-- and separates the two very different delays:
--   acknowledged_at → created_at   how long before anyone picked it up
--   on_the_way_at   → acknowledged how long the kitchen took
--   delivered_at    → on_the_way   how long it took to reach the guest
--
-- In the trigger, not the dashboard, for the same reason the high-water mark
-- is: a stamp that depends on which screen wrote the row is a stamp you can't
-- trust in a report.

alter table public.orders
  add column if not exists acknowledged_at timestamptz,
  add column if not exists on_the_way_at   timestamptz,
  add column if not exists delivered_at    timestamptz;

create or replace function public.stamp_order_status_times()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Fires whenever status appears in the SET list, even set to its current
  -- value — a double-tap of "Delivered ✓" shouldn't rewrite the time.
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Cancelling preserves the history: an order cancelled at 8pm was still
  -- genuinely acknowledged at 7:40, and that's the record of what happened.
  if new.status = 'cancelled' then
    return new;
  end if;

  -- Clear anything the order hasn't reached any more. This is what makes the
  -- step-back button honest — an order stepped back out of 'delivered' must
  -- not keep claiming a delivery time. Re-advancing writes the true, later
  -- timestamp rather than restoring the mis-tap.
  if order_status_rank(new.status) < 4 then new.delivered_at    := null; end if;
  if order_status_rank(new.status) < 3 then new.on_the_way_at   := null; end if;
  if order_status_rank(new.status) < 2 then new.acknowledged_at := null; end if;

  -- clock_timestamp(), not now(): now() is the TRANSACTION start time, so any
  -- two status changes sharing a transaction would record an identical time
  -- and report as zero elapsed. One tap is one transaction in production, but
  -- a bulk fix or a future batched write shouldn't silently flatten the data.
  if    new.status = 'preparing'  then new.acknowledged_at := clock_timestamp();
  elsif new.status = 'on_the_way' then new.on_the_way_at   := clock_timestamp();
  elsif new.status = 'delivered'  then new.delivered_at    := clock_timestamp();
  end if;

  return new;
end;
$$;

-- Separate trigger from orders_status_high_water: different columns, no
-- overlap, and keeping them apart means either can be reasoned about alone.
-- Both are BEFORE UPDATE, so both see the same OLD row.
drop trigger if exists orders_status_timestamps on public.orders;
create trigger orders_status_timestamps
  before update of status on public.orders
  for each row execute function public.stamp_order_status_times();

-- Deliberately NO backfill. Orders already delivered have no recoverable
-- timing, and inventing one from created_at would put fiction in a report
-- Lexi is going to read as fact. They stay null; the data starts tonight.
