-- Fan the orders INSERT webhook out to order-push as well as order-sms.
-- Same shared-secret placeholder rule as db/003: the real
-- ORDER_WEBHOOK_SECRET is substituted at apply time, never committed.
--
-- Both calls are fire-and-forget pg_net posts, so a slow or failing push
-- never blocks (or rolls back) the guest's order.

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
  perform net.http_post(
    url := 'https://lkeuiquqogtevsgvaddf.supabase.co/functions/v1/order-sms',
    headers := headers, body := payload);
  perform net.http_post(
    url := 'https://lkeuiquqogtevsgvaddf.supabase.co/functions/v1/order-push',
    headers := headers, body := payload);
  return new;
end;
$$;
