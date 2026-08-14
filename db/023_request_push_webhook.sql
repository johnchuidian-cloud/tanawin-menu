-- Push a new guest request to closed staff phones.
--
-- Until now only `orders` had an INSERT webhook, so a towel change or a
-- problem report reached nobody unless the dashboard happened to be open.
-- The 10-minute escalation was the only safety net — a guest could wait the
-- full ten minutes for the first sign that anyone knew.
--
-- Same shared-secret placeholder rule as db/003 and db/016: the real
-- ORDER_WEBHOOK_SECRET is substituted at apply time, never committed.
--
-- The overnight hold is enforced in the function, not here: a request the
-- guest was told would wait until 07:00 must not buzz the team at 2am. Those
-- still get picked up by request-escalate once staff are back on shift.

create or replace function public.notify_request_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Fire-and-forget, like the orders webhook: a slow or failing push must
  -- never block (or roll back) the guest's request.
  perform net.http_post(
    url := 'https://lkeuiquqogtevsgvaddf.supabase.co/functions/v1/order-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '__ORDER_WEBHOOK_SECRET__'
    ),
    body := jsonb_build_object(
      'request_id', new.id,
      'kind', new.kind,
      'room_name', new.room_name,
      'note', new.note,
      'out_of_hours', new.out_of_hours
    )
  );
  return new;
end;
$$;

drop trigger if exists requests_push_webhook on public.concierge_requests;
create trigger requests_push_webhook
  after insert on public.concierge_requests
  for each row execute function public.notify_request_push();
