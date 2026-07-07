-- Guest order-status peephole. Anon can't SELECT orders (by design);
-- this returns ONLY the status for a specific order id — the uuid acts
-- as the guest's claim ticket (returned to their phone at placement).

create or replace function public.get_order_status(p_order_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'order_number', o.order_number,
    'status', o.status,
    'created_at', o.created_at
  )
  from orders o
  where o.id = p_order_id;
$$;

revoke all on function public.get_order_status(uuid) from public;
grant execute on function public.get_order_status(uuid) to anon, authenticated;
