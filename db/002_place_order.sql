-- place_order: the one write path for anonymous guests.
-- Security definer so it can compute totals from menu_items and return the
-- order_number, neither of which anon's RLS policies allow directly.
-- Prices always come from the live menu — the client never sends amounts.

create or replace function public.place_order(
  p_room_number text,
  p_is_dining_in boolean,
  p_payment_intent text,
  p_note text,
  p_gcash_proof_url text,
  p_items jsonb  -- [{"menu_item_id": uuid, "qty": int}, ...]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_order_number bigint;
  v_total numeric(10,2);
  v_bad int;
  v_count int;
begin
  if p_payment_intent not in ('room', 'gcash', 'cash') then
    raise exception 'invalid payment intent';
  end if;
  if not p_is_dining_in and nullif(btrim(coalesce(p_room_number, '')), '') is null then
    raise exception 'room number required unless dining in';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 60 then
    raise exception 'invalid order items';
  end if;

  with req as (
    select (e ->> 'menu_item_id')::uuid as mid, (e ->> 'qty')::int as qty
    from jsonb_array_elements(p_items) e
  )
  select round(sum(m.price * req.qty), 2),
         count(*) filter (where m.id is null or not m.is_available
                          or req.qty is null or req.qty < 1 or req.qty > 50),
         count(*)
  into v_total, v_bad, v_count
  from req left join menu_items m on m.id = req.mid;

  if v_bad > 0 then
    raise exception 'an item in the order is unavailable or invalid';
  end if;

  insert into orders (room_number, is_dining_in, payment_intent, gcash_proof_url, note, total)
  values (
    case when p_is_dining_in then null else btrim(p_room_number) end,
    p_is_dining_in,
    p_payment_intent,
    nullif(btrim(coalesce(p_gcash_proof_url, '')), ''),
    nullif(btrim(coalesce(p_note, '')), ''),
    v_total
  )
  returning id, order_number into v_order_id, v_order_number;

  insert into order_items (order_id, menu_item_id, item_name, qty, unit_price, line_total)
  select v_order_id, m.id, m.name, req.qty, m.price, round(m.price * req.qty, 2)
  from (
    select (e ->> 'menu_item_id')::uuid as mid, (e ->> 'qty')::int as qty
    from jsonb_array_elements(p_items) e
  ) req
  join menu_items m on m.id = req.mid;

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'total', v_total
  );
end;
$$;

revoke all on function public.place_order(text, boolean, text, text, text, jsonb) from public;
grant execute on function public.place_order(text, boolean, text, text, text, jsonb) to anon, authenticated;
