-- Orders taken on paper.
--
-- An 18-guest dining tab was written by hand because there was no way to key
-- it in, and it then existed nowhere: not in the queue, not in the export, not
-- in the totals Lexi reconciles against Finance.
--
-- Deliberately NOT built as a scan-and-OCR feature. Handwriting, no fixed
-- form, Filipino dish names in columns — every scanned line would need a human
-- to check it against the paper, which adds a step instead of removing one,
-- and leaves you with a picture where you wanted itemised data. Staff tap the
-- real menu instead (server-priced, same as a guest order) and may ALSO attach
-- a photo of the slip as the source document.
--
-- Signature: only "charge to room" needs one — for cash or GCash the payment
-- is its own proof and a signature is friction for nothing. On a tab this size
-- a legible printed name matters more than the squiggle, so both are captured.
-- Independently, entered_by records the staff member who keyed it: a paper
-- order has no guest-side evidence it was ever placed, so whoever entered it
-- is the accountable party whether or not a guest signed.

alter table public.orders
  add column if not exists is_manual         boolean not null default false,
  add column if not exists entered_by        text,
  add column if not exists guest_signed_name text,
  add column if not exists paper_url         text;

-- Photos of paper slips: private, staff-only, same shape as gcash-proofs.
insert into storage.buckets (id, name, public)
values ('paper-orders', 'paper-orders', false)
on conflict (id) do nothing;

drop policy if exists "staff write paper orders" on storage.objects;
create policy "staff write paper orders" on storage.objects
  for insert to authenticated with check (bucket_id = 'paper-orders');
drop policy if exists "staff read paper orders" on storage.objects;
create policy "staff read paper orders" on storage.objects
  for select to authenticated using (bucket_id = 'paper-orders');

-- The signatures bucket has only ever been written by the guest app, so its
-- one INSERT policy is for anon. A paper order is signed on the STAFF device,
-- by a logged-in user — which that policy silently rejects with a 403.
drop policy if exists "staff upload signature" on storage.objects;
create policy "staff upload signature" on storage.objects
  for insert to authenticated with check (bucket_id = 'signatures');

-- A manual order must never buzz five phones. The staff member entering it is
-- standing right there, and every open dashboard sees it arrive over realtime
-- anyway. Push exists for orders that turn up unattended from a guest.
-- (Escalation is untouched: a manual order left sitting in 'new' is a real
-- forgotten order and deserves the 10-minute nudge like any other.)
create or replace function public.notify_order_sms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payload jsonb := jsonb_build_object(
    'order_id', new.id,
    'order_number', new.order_number,
    'room_number', new.room_number,
    'is_dining_in', new.is_dining_in,
    'total', new.total
  );
  headers jsonb := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-webhook-secret', '__ORDER_WEBHOOK_SECRET__'
  );
begin
  if new.is_manual then
    return new;
  end if;
  perform net.http_post(
    url := 'https://lkeuiquqogtevsgvaddf.supabase.co/functions/v1/order-sms',
    headers := headers, body := payload);
  perform net.http_post(
    url := 'https://lkeuiquqogtevsgvaddf.supabase.co/functions/v1/order-push',
    headers := headers, body := payload);
  return new;
end;
$$;

-- Staff-side twin of place_order. Separate function rather than a flag on that
-- one because the two differ in every gate that matters: no access code (the
-- staff session IS the authorisation), no per-room rate cap, and a choice of
-- starting status. Prices are still resolved server-side from the live menu,
-- so a keyed order can't carry a total anyone typed.
create or replace function public.place_manual_order(
  p_room_name text,            -- null when they were eating in the dining area
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
  p_ordered_at timestamptz default null   -- admin back-dating; null = now
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
  -- Same gate concierge_requests uses: an ACTIVE staff row, not merely a
  -- logged-in GoTrue user. A deactivated account must not be able to write
  -- orders just because its session hasn't expired yet.
  select * into v_staff from staff where auth_uid = auth.uid() and is_active;
  if not found then
    raise exception 'not authorised';
  end if;

  if p_payment_intent not in ('room', 'gcash', 'cash') then
    raise exception 'invalid payment intent';
  end if;
  if not p_is_dining_in and nullif(btrim(coalesce(p_room_name, '')), '') is null then
    raise exception 'room required unless dining in';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 120 then
    raise exception 'invalid order items';
  end if;

  -- Back-dating is an admin power: it moves an order into a period Lexi may
  -- already have reconciled, so it isn't something a rushed shift should do
  -- by accident. Everyone else's orders are stamped now.
  v_created := case
    when p_ordered_at is not null and v_staff.role = 'admin' then p_ordered_at
    else now()
  end;
  if v_created > now() + interval '1 minute' then
    raise exception 'cannot record an order in the future';
  end if;

  -- 120 not 60: a hand-written tab for a large party legitimately runs longer
  -- than anything a guest taps into a phone.
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
         -- is_available is NOT checked here, unlike place_order: staff are
         -- recording something already cooked and eaten, and an item taken off
         -- the menu since must not make last night's tab unrecordable.
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

  -- INSERT ... status='delivered' skips the UPDATE trigger that normally
  -- stamps the timings, so set the high-water mark by hand. The times stay
  -- null on purpose: nobody knows when a paper order was really handed over,
  -- and inventing a figure would poison the service-time report.
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
