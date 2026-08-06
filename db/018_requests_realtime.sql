-- Concierge guest requests share Menu's staff dashboard feed (suite
-- connection #7), so realtime has to carry them the way it carries orders.
-- The table shipped without being published — only `orders` was — which
-- would have left requests arriving silently until a manual refresh.
alter publication supabase_realtime add table public.concierge_requests;
