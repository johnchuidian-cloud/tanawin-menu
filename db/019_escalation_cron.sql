-- Escalation sweep for ignored guest requests (suite connection #7).
-- Time passing with nothing happening can't be caught by a trigger, so a
-- cron job pokes the request-escalate function every 3 minutes; the function
-- itself decides what is stale (10 min unacknowledged) and stamps
-- escalated_at so nothing nags twice.
--
-- Same placeholder rule as db/003 and db/016: the real ORDER_WEBHOOK_SECRET
-- is substituted at apply time and never committed.

create extension if not exists pg_cron;

-- re-runnable: drop any previous incarnation of the job first
select cron.unschedule('escalate-guest-requests')
where exists (select 1 from cron.job where jobname = 'escalate-guest-requests');

select cron.schedule(
  'escalate-guest-requests',
  '*/3 * * * *',
  $job$
  select net.http_post(
    url := 'https://lkeuiquqogtevsgvaddf.supabase.co/functions/v1/request-escalate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '__ORDER_WEBHOOK_SECRET__'
    ),
    body := '{}'::jsonb
  );
  $job$
);
