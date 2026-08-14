-- Dining-in orders arrive with no way to find the diner.
--
-- Order #33 is the case in point: the guest used the Glamping Tent 4 code and
-- chose to eat in the dining room. The database knew "Glamping Tent 4" the
-- whole time (access_room, set by place_order), but the staff card said only
-- "Dining in", so whoever carried the tray upstairs had a floor of tables and
-- no name. Three parts to fixing it:
--
--   1. surface access_room, which was already being stored and thrown away
--   2. guest_name  — who to ask for
--   3. table_label — where they're sitting
--
-- Both new fields are nullable and optional. The tables have no physical
-- numbers on them yet; once Lexi puts them out, table_label becomes required
-- (option B, agreed) — a NOT NULL now would just block orders.
--
-- room_number is deliberately NOT reused for the table: NULL there is the
-- meaningful signal "this is a dining-in order", and overloading it would
-- destroy that distinction everywhere it's read.

alter table public.orders
  add column if not exists guest_name  text,
  add column if not exists table_label text;

-- The 7-arg version must go before the 9-arg one lands: PostgREST resolves
-- overloads by the argument names it's given, and two candidates that both
-- match a 7-key body is an ambiguity error, not a fallback. Dropping first
-- means the only window is this migration itself. Keeping DEFAULTs on the two
-- new params is what lets a browser running yesterday's JS keep ordering.
drop function if exists public.place_order(text, boolean, text, text, text, jsonb, text);

create or replace function public.place_order(
  p_access_code text,
  p_is_dining_in boolean,
  p_payment_intent text,
  p_note text,
  p_gcash_proof_url text,
  p_items jsonb,
  p_signature_url text default null,
  p_guest_name text default null,
  p_table_label text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room rooms%rowtype;
  v_recent int;
  v_order_id uuid;
  v_order_number bigint;
  v_total numeric(10,2);
  v_bad int;
begin
  select * into v_room
  from rooms
  where code = btrim(coalesce(p_access_code, '')) and is_active;
  if not found then
    raise exception 'invalid or inactive access code';
  end if;
  if not p_is_dining_in and v_room.kind <> 'room' then
    raise exception 'this code is for dining in only';
  end if;

  if p_payment_intent not in ('room', 'gcash', 'cash') then
    raise exception 'invalid payment intent';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 60 then
    raise exception 'invalid order items';
  end if;

  -- soft rate cap per authorizing room, in case a code leaks
  select count(*) into v_recent
  from orders
  where access_room = v_room.name
    and created_at > now() - interval '1 hour';
  if v_recent >= 30 then
    raise exception 'too many orders from this room this hour';
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

  insert into orders (room_number, is_dining_in, payment_intent, gcash_proof_url,
                      note, total, signature_url, access_room, guest_name, table_label)
  values (
    case when p_is_dining_in then null else v_room.name end,
    p_is_dining_in,
    p_payment_intent,
    nullif(btrim(coalesce(p_gcash_proof_url, '')), ''),
    nullif(btrim(coalesce(p_note, '')), ''),
    v_total,
    nullif(btrim(coalesce(p_signature_url, '')), ''),
    v_room.name,
    left(nullif(btrim(coalesce(p_guest_name, '')), ''), 60),
    left(nullif(btrim(coalesce(p_table_label, '')), ''), 20)
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
    'total', v_total,
    'room_number', case when p_is_dining_in then null else v_room.name end
  );
end;
$$;

revoke all on function public.place_order(text, boolean, text, text, text, jsonb, text, text, text) from public;
grant execute on function public.place_order(text, boolean, text, text, text, jsonb, text, text, text) to anon, authenticated;
