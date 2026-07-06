-- Webhook: orders INSERT → order-sms Edge Function (handoff §7).
-- The committed file carries a placeholder; the real ORDER_WEBHOOK_SECRET is
-- substituted at apply time (it lives in .env.local and in function secrets).

create extension if not exists pg_net;

create or replace function public.notify_order_sms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://lkeuiquqogtevsgvaddf.supabase.co/functions/v1/order-sms',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '__ORDER_WEBHOOK_SECRET__'
    ),
    body := jsonb_build_object(
      'order_id', new.id,
      'order_number', new.order_number,
      'room_number', new.room_number,
      'is_dining_in', new.is_dining_in,
      'total', new.total
    )
  );
  return new;
end;
$$;

drop trigger if exists orders_sms_webhook on public.orders;
create trigger orders_sms_webhook
  after insert on public.orders
  for each row execute function public.notify_order_sms();
