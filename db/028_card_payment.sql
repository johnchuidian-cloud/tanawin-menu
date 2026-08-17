-- Credit/debit card, settled on the Maya terminal at the front desk.
--
-- Numbering note: the work order said db/018, but that number has been taken
-- since Concierge phase 2 (concierge_requests realtime) and the repo is at
-- 027. Using the next free number keeps the sequence meaningful.
--
-- Verified against the LIVE database before writing this, not against the
-- migration files: payment_intent is plain `text` (NOT NULL, no default)
-- policed by a CHECK constraint listing room/gcash/cash. So the change is to
-- that constraint — there is no enum type to alter.
--
-- Card is deliberately available to room and dining codes alike: a walk-in
-- diner is exactly the person most likely to want to pay by card, and the
-- terminal is at the desk either way.

alter table public.orders drop constraint if exists orders_payment_intent_check;
alter table public.orders add constraint orders_payment_intent_check
  check (payment_intent in ('room', 'gcash', 'cash', 'card'));

-- Maya's reference number, typed in by staff after the swipe. Nullable, and
-- not card-only on purpose: a GCash reference belongs here too when Lexi
-- wants to start recording those.
alter table public.orders
  add column if not exists payment_ref text;

-- Writing the reference is staff-only.
--
-- The UPDATE policy already covers it: `staff update orders` is the only
-- UPDATE policy and it's granted to `authenticated`, so anon simply has no
-- UPDATE path. INSERT is the gap — `anon place order` grants anon a direct
-- INSERT with `check (true)`, so a guest could in principle POST an order row
-- carrying its own payment_ref, bypassing place_order entirely.
--
-- Stripping it in a trigger rather than removing that policy: place_order is
-- SECURITY DEFINER and doesn't rely on the policy, so the policy looks
-- removable — but it has been live since day one and this migration is not
-- the place to find out what else leans on it. auth.uid() is null for anon
-- and set for a signed-in staff member, which is exactly the line we want.
create or replace function public.strip_guest_payment_ref()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    new.payment_ref := null;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_strip_guest_payment_ref on public.orders;
create trigger orders_strip_guest_payment_ref
  before insert on public.orders
  for each row execute function public.strip_guest_payment_ref();

-- place_order gains 'card' and nothing else. It has never taken a payment_ref
-- parameter and still doesn't, so the column is null by construction on the
-- guest path — the trigger above is the belt to that pair of braces. Total
-- computation is untouched.
--
-- Re-created wholesale rather than patched because the body is the live
-- definition pulled from the database, which is the authority here.
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

  if p_payment_intent not in ('room', 'gcash', 'cash', 'card') then
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
                      note, total, signature_url, access_room, guest_name, table_label,
                      payment_ref)
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
    left(nullif(btrim(coalesce(p_table_label, '')), ''), 20),
    null                      -- never from the guest; staff type it after the swipe
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

-- Staff-entered orders can be card too: someone paying by card at the desk for
-- a tab taken on paper is the same transaction from the other end. Only the
-- payment list changes; the rest is db/027's body unchanged.
create or replace function public.place_manual_order(
  p_room_name text,
  p_is_dining_in boolean,
  p_payment_intent text,
  p_note text,
  p_items jsonb,
  p_guest_name text default null,
  p_table_label text default null,
  p_signature_url text default null,
  p_guest_signed_name text default null,
  p_paper_url text default null,
  p_already_served boolean default false,
  p_ordered_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff   record;
  v_order_id uuid;
  v_order_number bigint;
  v_total numeric(10,2);
  v_bad int;
  v_created timestamptz;
  v_status text;
begin
  select * into v_staff from staff where auth_uid = auth.uid() and is_active;
  if not found then
    raise exception 'not authorised';
  end if;

  if p_payment_intent not in ('room', 'gcash', 'cash', 'card') then
    raise exception 'invalid payment intent';
  end if;
  if not p_is_dining_in and nullif(btrim(coalesce(p_room_name, '')), '') is null then
    raise exception 'room required unless dining in';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 120 then
    raise exception 'invalid order items';
  end if;

  v_created := case
    when p_ordered_at is not null and v_staff.role = 'admin' then p_ordered_at
    else now()
  end;
  if v_created > now() + interval '1 minute' then
    raise exception 'cannot record an order in the future';
  end if;

  with req as (
    select (e ->> 'menu_item_id')::uuid as mid,
           (e ->> 'qty')::int as qty,
           nullif(btrim(coalesce(e ->> 'option', '')), '') as opt
    from jsonb_array_elements(p_items) e
  ),
  priced as (
    select req.qty, req.opt, m.id as m_id,
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
         count(*) filter (where m_id is null or qty is null or qty < 1 or qty > 50 or bad_opt)
  into v_total, v_bad
  from priced;

  if v_bad > 0 then
    raise exception 'an item in the order is invalid';
  end if;

  v_status := case when p_already_served then 'delivered' else 'new' end;

  insert into orders (
    room_number, is_dining_in, payment_intent, note, total, created_at, status,
    access_room, guest_name, table_label, signature_url,
    is_manual, entered_by, guest_signed_name, paper_url
  ) values (
    case when p_is_dining_in then null else btrim(p_room_name) end,
    p_is_dining_in,
    p_payment_intent,
    nullif(btrim(coalesce(p_note, '')), ''),
    v_total,
    v_created,
    v_status,
    nullif(btrim(coalesce(p_room_name, '')), ''),
    left(nullif(btrim(coalesce(p_guest_name, '')), ''), 60),
    left(nullif(btrim(coalesce(p_table_label, '')), ''), 20),
    nullif(btrim(coalesce(p_signature_url, '')), ''),
    true,
    v_staff.name,
    left(nullif(btrim(coalesce(p_guest_signed_name, '')), ''), 60),
    nullif(btrim(coalesce(p_paper_url, '')), '')
  )
  returning id, order_number into v_order_id, v_order_number;

  if p_already_served then
    update orders set status_high_water = 'delivered' where id = v_order_id;
  end if;

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
    'entered_by', v_staff.name
  );
end;
$$;

revoke all on function public.place_manual_order(
  text, boolean, text, text, jsonb, text, text, text, text, text, boolean, timestamptz) from public;
grant execute on function public.place_manual_order(
  text, boolean, text, text, jsonb, text, text, text, text, text, boolean, timestamptz) to authenticated;
