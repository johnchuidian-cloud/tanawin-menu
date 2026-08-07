-- Let food orders escalate like guest requests do.
--
-- Until now only concierge_requests escalated: a forgotten towel nudged the
-- whole team after 10 minutes, but a forgotten DINNER did nothing. The chime
-- also gives up after ~5 minutes, so an unnoticed order could then sit in
-- silence. An order with status 'new' has had nobody tap "Start prepping".
--
-- Nullable column, stamped once by request-escalate so an order can't nag twice.

alter table public.orders add column if not exists escalated_at timestamptz;
