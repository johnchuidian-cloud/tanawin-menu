-- Priced options + expandable categories (real-menu decisions, 2026-07-07):
-- 1. Options may carry their own price: [{"label":"for 2","price":479}, ...].
--    A null/absent price falls back to the item's base price, and plain-string
--    options ("Hot") keep working.
-- 2. Categories move from a hard-coded CHECK constraint to a table staff can
--    add to from the dashboard (menu expansion: burgers, kombucha, ...).

create table public.categories (
  name text primary key,
  sort_order int not null default 0
);

alter table public.categories enable row level security;
create policy "anon read categories" on public.categories
  for select to anon using (true);
create policy "staff read categories" on public.categories
  for select to authenticated using (true);
create policy "staff insert categories" on public.categories
  for insert to authenticated with check (true);
create policy "staff update categories" on public.categories
  for update to authenticated using (true);
create policy "staff delete categories" on public.categories
  for delete to authenticated using (true);

insert into public.categories (name, sort_order) values
  ('Chicken', 1), ('Seafood', 2), ('Vegetables', 3), ('Soup & Pancit', 4),
  ('Crepes', 5), ('Pika-Pika', 6), ('Silogs', 7), ('Beverages', 8), ('Extras', 9);

alter table public.menu_items drop constraint menu_items_category_check;
alter table public.menu_items add constraint menu_items_category_fkey
  foreign key (category) references public.categories(name) on update cascade;

-- place_order: option may set the unit price
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
  ),
  priced as (
    select req.qty, req.opt,
           m.id as m_id, m.is_available,
           coalesce(op.price, m.price) as unit_price,
           (req.opt is not null and op.found is not true) as bad_opt
    from req
    left join menu_items m on m.id = req.mid
    left join lateral (
      select true as found,
             case when jsonb_typeof(e) = 'object'
                  then (e ->> 'price')::numeric(10,2) end as price
      from jsonb_array_elements(coalesce(m.options, '[]'::jsonb)) e
      where coalesce(e ->> 'label', e #>> '{}') = req.opt
      limit 1
    ) op on true
  )
  select round(sum(unit_price * qty), 2),
         count(*) filter (where m_id is null or not is_available
                          or qty is null or qty < 1 or qty > 50 or bad_opt)
  into v_total, v_bad
  from priced;

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
         coalesce(op.price, m.price),
         round(coalesce(op.price, m.price) * req.qty, 2)
  from (
    select (e ->> 'menu_item_id')::uuid as mid,
           (e ->> 'qty')::int as qty,
           nullif(btrim(coalesce(e ->> 'option', '')), '') as opt
    from jsonb_array_elements(p_items) e
  ) req
  join menu_items m on m.id = req.mid
  left join lateral (
    select case when jsonb_typeof(e) = 'object'
                then (e ->> 'price')::numeric(10,2) end as price
    from jsonb_array_elements(coalesce(m.options, '[]'::jsonb)) e
    where coalesce(e ->> 'label', e #>> '{}') = req.opt
    limit 1
  ) op on true;

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'total', v_total
  );
end;
$$;

revoke all on function public.place_order(text, boolean, text, text, text, jsonb) from public;
grant execute on function public.place_order(text, boolean, text, text, text, jsonb) to anon, authenticated;
