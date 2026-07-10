-- Room access codes (anti-spam gate, John 2026-07-08):
-- Guests must enter their room's code (given at check-in) to place ANY
-- order. The code is validated server-side inside place_order and also
-- RESOLVES the room — the client no longer names its own room. A special
-- "Dining Area" code covers walk-in diners (staff share it on request).
--
-- Codes are generated IN the database (never committed — the mirror repo
-- is public) and are readable only by authenticated staff: the rooms
-- table has NO anon policies, so codes can never be scraped from a
-- guest's phone.

create table public.rooms (
  name text primary key,
  code text not null unique,
  kind text not null default 'room' check (kind in ('room', 'dining')),
  is_active boolean not null default true,
  created_at timestamptz default now()
);

alter table public.rooms enable row level security;
create policy "staff read rooms" on public.rooms
  for select to authenticated using (true);
create policy "staff insert rooms" on public.rooms
  for insert to authenticated with check (true);
create policy "staff update rooms" on public.rooms
  for update to authenticated using (true);
create policy "staff delete rooms" on public.rooms
  for delete to authenticated using (true);

insert into public.rooms (name, kind, code)
select r.name, r.kind, lpad(floor(random() * 1000000)::int::text, 6, '0')
from (values
  ('Tanawin House', 'room'),
  ('Glamping Tent 1', 'room'),
  ('Glamping Tent 2', 'room'),
  ('Glamping Tent 3', 'room'),
  ('Glamping Tent 4', 'room'),
  ('Ambon Ambon Falls', 'room'),
  ('Bisay Falls', 'room'),
  ('Kairukan Falls', 'room'),
  ('Dunsulan Falls', 'room'),
  ('Limutan Falls', 'room'),
  ('Pasukulan Falls', 'room'),
  ('Silanganan Falls', 'room'),
  ('Tikip Falls', 'room'),
  ('Dining Area', 'dining')
) as r(name, kind);

-- Which room's code authorized each order (also the rate-limit bucket).
alter table public.orders add column if not exists access_room text;

-- Belt-and-suspenders on the two anonymous-write buckets: cap size, images only.
update storage.buckets
set file_size_limit = 5242880,  -- 5 MB
    allowed_mime_types = array['image/png','image/jpeg','image/webp','image/heic','image/heif']
where id in ('gcash-proofs', 'signatures');

-- place_order: p_room_number is GONE; p_access_code replaces it.
drop function public.place_order(text, boolean, text, text, text, jsonb, text);

create function public.place_order(
  p_access_code text,
  p_is_dining_in boolean,
  p_payment_intent text,
  p_note text,
  p_gcash_proof_url text,
  p_items jsonb,  -- [{"menu_item_id": uuid, "qty": int, "option": string|null}, ...]
  p_signature_url text default null
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

  insert into orders (room_number, is_dining_in, payment_intent, gcash_proof_url, note, total, signature_url, access_room)
  values (
    case when p_is_dining_in then null else v_room.name end,
    p_is_dining_in,
    p_payment_intent,
    nullif(btrim(coalesce(p_gcash_proof_url, '')), ''),
    nullif(btrim(coalesce(p_note, '')), ''),
    v_total,
    nullif(btrim(coalesce(p_signature_url, '')), ''),
    v_room.name
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

revoke all on function public.place_order(text, boolean, text, text, text, jsonb, text) from public;
grant execute on function public.place_order(text, boolean, text, text, text, jsonb, text) to anon, authenticated;
