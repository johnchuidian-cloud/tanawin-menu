-- Item options (e.g. a drink served Hot or Iced).
-- menu_items.options: jsonb array of strings, null = no options.
-- The chosen option is validated server-side and baked into the
-- order_items.item_name snapshot ("Calamansi Juice (Iced)"), so it
-- automatically shows on the staff queue, in history, and in the SMS.

alter table public.menu_items add column if not exists options jsonb;

create or replace function public.place_order(
  p_room_number text,
  p_is_dining_in boolean,
  p_payment_intent text,
  p_note text,
  p_gcash_proof_url text,
  p_items jsonb  -- [{"menu_item_id": uuid, "qty": int, "option": string|null}, ...]
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
    select (e ->> 'menu_item_id')::uuid as mid,
           (e ->> 'qty')::int as qty,
           nullif(btrim(coalesce(e ->> 'option', '')), '') as opt
    from jsonb_array_elements(p_items) e
  )
  select round(sum(m.price * req.qty), 2),
         count(*) filter (where m.id is null or not m.is_available
                          or req.qty is null or req.qty < 1 or req.qty > 50
                          or (req.opt is not null
                              and (m.options is null or not m.options ? req.opt))),
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
  select v_order_id,
         m.id,
         m.name || coalesce(' (' || req.opt || ')', ''),
         req.qty,
         m.price,
         round(m.price * req.qty, 2)
  from (
    select (e ->> 'menu_item_id')::uuid as mid,
           (e ->> 'qty')::int as qty,
           nullif(btrim(coalesce(e ->> 'option', '')), '') as opt
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

-- Seed: the drink that started this ("Freshly squeezed, hot or iced")
update public.menu_items set options = '["Hot","Iced"]'::jsonb
where name = 'Calamansi Juice';
