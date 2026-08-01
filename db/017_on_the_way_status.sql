-- Lexi asked for one more step between "being prepped" and the end, so staff
-- can tell the guest the food has left the kitchen, then confirm it was
-- actually handed over.
--
--   new → preparing → on_the_way → delivered
--
-- Meaning shift: 'delivered' used to be the LAST staff tap and doubled as the
-- guest's "ready!" signal. That signal is now 'on_the_way', and 'delivered'
-- means the guest physically has it. Existing rows keep 'delivered' — they're
-- historical and already finished either way.

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new', 'preparing', 'on_the_way', 'delivered', 'cancelled'));
