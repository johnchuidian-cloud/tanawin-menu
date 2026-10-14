-- 034: push notifications for manual orders that are actually sent to the kitchen.
--
-- db/027 made every manual order silent, on the reasoning that "the staff
-- member entering it is standing right there" and every open dashboard already
-- sees it over realtime. That holds for its original use — typing up a paper
-- slip for an order that has already been served.
--
-- It does not hold for the other half of the same form: the "No — send it to
-- the kitchen" branch, which exists so an order can be placed FOR a guest (a
-- phone call, the front desk, someone asking in person) and worked like any
-- other. There the person entering it is NOT standing next to whoever cooks,
-- and realtime only reaches a dashboard that is open. A locked phone got
-- nothing, so the order sat in 'new' until someone happened to look.
--
-- So: push follows the status, not the is_manual flag.
--   guest order            -> SMS + push   (unchanged)
--   manual, status 'new'   -> push          (new: it is a real job for someone)
--   manual, 'delivered'    -> silent        (already served; nothing to chase)
--
-- SMS stays off for manual orders either way. It is a paid per-message channel
-- aimed at an unattended order arriving from a guest, and a staff member who
-- just keyed an order in does not need to be texted about it.
--
-- Escalation is untouched and still applies: a manual order left in 'new' gets
-- the 10-minute nudge like any other.
--
-- The committed file carries the __ORDER_WEBHOOK_SECRET__ placeholder; the real
-- value is substituted at apply time and never committed. Same rule as db/003,
-- 016, 019, 023 and 027.

create or replace function public.notify_order_sms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payload jsonb := jsonb_build_object(
    'order_id', new.id,
    'order_number', new.order_number,
    'room_number', new.room_number,
    'is_dining_in', new.is_dining_in,
    'total', new.total
  );
  headers jsonb := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-webhook-secret', '__ORDER_WEBHOOK_SECRET__'
  );
begin
  -- A manual order that was recorded as already served is history, not work.
  if new.is_manual and new.status <> 'new' then
    return new;
  end if;

  if not new.is_manual then
    perform net.http_post(
      url := 'https://lkeuiquqogtevsgvaddf.supabase.co/functions/v1/order-sms',
      headers := headers, body := payload);
  end if;

  perform net.http_post(
    url := 'https://lkeuiquqogtevsgvaddf.supabase.co/functions/v1/order-push',
    headers := headers, body := payload);
  return new;
end;
$$;

-- The trigger itself is unchanged: after insert on orders, per db/003.
--
-- No `revoke ... from anon` here, and that is deliberate rather than a miss of
-- the standing rule. This is a trigger function: plpgsql refuses to run it
-- unless a trigger called it (CALLED_AS_TRIGGER), so the default EXECUTE grant
-- buys an attacker nothing, and Postgres does not re-check that grant when the
-- trigger fires. Revoking would protect nothing while putting the guest
-- ordering path one permission check away from breaking. The grants that do
-- matter here are place_order / place_manual_order, handled in db/033.
