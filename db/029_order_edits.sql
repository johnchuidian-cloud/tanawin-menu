-- Editing an order after the fact, with a trail and an owner's veto.
--
-- Rio asked how to edit. The honest answer was "you can't" — only the
-- Senior/PWD discount and the Maya reference were changeable, and everything
-- else meant cancelling and re-keying. Meanwhile order #60 sits filed as
-- GCash with "Credit card" typed in the note, because card didn't exist when
-- he recorded it. Several older orders are wrong the same way.
--
-- ADMIN ONLY, on John's instruction, to prevent pilferage: an order's total
-- is money owed, and a staff member who can quietly drop a line item from a
-- settled tab can pocket the difference. Editing is therefore restricted to
-- role='admin' (Lexi and Rio), and every edit is recorded with who, when and
-- WHY — the reason is required, not optional, because a trail nobody can
-- interpret is not a trail.
--
-- Lexi is prime. Her own edits are self-approved (she is the approver); an
-- edit by any other admin lands as 'pending' for her to approve or veto.
-- A veto restores the snapshot taken immediately before the edit, so undo is
-- exact rather than a best-effort retype.
--
-- Edits APPLY IMMEDIATELY rather than waiting in a queue. Rio is a co-owner
-- fixing his own records, not a request for permission, and an order that
-- displays stale figures until someone wakes up is worse than one that is
-- right now and reviewed later. The veto is what makes that safe.

alter table public.orders
  add column if not exists edit_log jsonb not null default '[]'::jsonb;

-- Snapshot of everything an edit can change, so a veto can put it all back.
create or replace function public.order_snapshot(p_order_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'payment_intent', o.payment_intent,
    'note', o.note,
    'guest_name', o.guest_name,
    'table_label', o.table_label,
    'is_dining_in', o.is_dining_in,
    'room_number', o.room_number,
    'total', o.total,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'menu_item_id', i.menu_item_id, 'item_name', i.item_name,
               'qty', i.qty, 'unit_price', i.unit_price, 'line_total', i.line_total))
      from order_items i where i.order_id = o.id), '[]'::jsonb)
  )
  from orders o where o.id = p_order_id;
$$;

create or replace function public.edit_order(
  p_order_id uuid,
  p_reason text,
  p_payment_intent text,
  p_note text,
  p_guest_name text,
  p_table_label text,
  p_is_dining_in boolean,
  p_room_name text,
  p_items jsonb              -- null = leave the item list alone
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff  record;
  v_before jsonb;
  v_after  jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_total  numeric(10,2);
  v_bad    int;
  v_key    text;
  v_entry  jsonb;
begin
  select * into v_staff from staff where auth_uid = auth.uid() and is_active;
  if not found then
    raise exception 'not authorised';
  end if;
  if v_staff.role <> 'admin' then
    raise exception 'only an admin can edit an order';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required';
  end if;
  if p_payment_intent not in ('room', 'gcash', 'cash', 'card') then
    raise exception 'invalid payment intent';
  end if;
  if not p_is_dining_in and nullif(btrim(coalesce(p_room_name, '')), '') is null then
    raise exception 'room required unless dining in';
  end if;

  v_before := order_snapshot(p_order_id);
  if v_before is null then
    raise exception 'order not found';
  end if;

  -- Items are optional: most edits are a payment method or a typo, and
  -- re-sending an unchanged list would churn order_items for nothing.
  if p_items is not null then
    if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0
       or jsonb_array_length(p_items) > 120 then
      raise exception 'invalid order items';
    end if;

    -- Prices come from the live menu, exactly as when the order was placed.
    -- An admin can change WHAT was ordered; they can never type what it cost.
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

    delete from order_items where order_id = p_order_id;
    insert into order_items (order_id, menu_item_id, item_name, qty, unit_price, line_total)
    select p_order_id, m.id,
           m.name || coalesce(' (' || req.opt || ')', ''),
           req.qty, coalesce(op.price, m.price),
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
  else
    v_total := (v_before ->> 'total')::numeric(10,2);
  end if;

  update orders set
    payment_intent = p_payment_intent,
    note           = nullif(btrim(coalesce(p_note, '')), ''),
    guest_name     = left(nullif(btrim(coalesce(p_guest_name, '')), ''), 60),
    table_label    = left(nullif(btrim(coalesce(p_table_label, '')), ''), 20),
    is_dining_in   = p_is_dining_in,
    room_number    = case when p_is_dining_in then null else btrim(p_room_name) end,
    total          = v_total
  where id = p_order_id;

  v_after := order_snapshot(p_order_id);

  -- Record only what actually moved, so the trail reads as a list of real
  -- changes instead of a wall of unchanged fields.
  for v_key in select jsonb_object_keys(v_before) loop
    if (v_before -> v_key) is distinct from (v_after -> v_key) then
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_array(v_before -> v_key, v_after -> v_key));
    end if;
  end loop;

  if v_changes = '{}'::jsonb then
    return jsonb_build_object('ok', true, 'unchanged', true);
  end if;

  v_entry := jsonb_build_object(
    'id', gen_random_uuid(),
    'at', to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD"T"HH24:MI:SS'),
    'by', v_staff.name,
    'reason', btrim(p_reason),
    'changes', v_changes,
    'before', v_before,
    -- Lexi is the approver, so she cannot be waiting on herself.
    'review', case when v_staff.is_prime then 'approved' else 'pending' end
  );

  update orders set edit_log = edit_log || jsonb_build_array(v_entry)
   where id = p_order_id;

  return jsonb_build_object('ok', true, 'total', v_total,
                            'review', v_entry ->> 'review',
                            'changed', (select count(*) from jsonb_object_keys(v_changes)));
end;
$$;

revoke all on function public.edit_order(uuid, text, text, text, text, text, boolean, text, jsonb) from public;
grant execute on function public.edit_order(uuid, text, text, text, text, text, boolean, text, jsonb) to authenticated;

-- Lexi's review. Approve records that she has seen it; veto puts the order
-- back exactly as it was before that edit.
create or replace function public.review_order_edit(
  p_order_id uuid,
  p_edit_id text,
  p_approve boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff record;
  v_log   jsonb;
  v_idx   int;
  v_entry jsonb;
  v_before jsonb;
begin
  select * into v_staff from staff where auth_uid = auth.uid() and is_active;
  if not found or not v_staff.is_prime then
    raise exception 'only the owner can review edits';
  end if;

  select edit_log into v_log from orders where id = p_order_id;
  if v_log is null then
    raise exception 'order not found';
  end if;

  select i into v_idx
  from generate_series(0, jsonb_array_length(v_log) - 1) i
  where v_log -> i ->> 'id' = p_edit_id;
  if v_idx is null then
    raise exception 'edit not found';
  end if;
  v_entry := v_log -> v_idx;

  if not p_approve then
    -- Undo only the most recent edit. Restoring an older snapshot would
    -- silently discard every edit made after it, which is a surprise nobody
    -- wants from a button labelled "undo".
    if v_idx <> jsonb_array_length(v_log) - 1 then
      raise exception 'only the most recent edit can be undone';
    end if;
    v_before := v_entry -> 'before';

    update orders set
      payment_intent = v_before ->> 'payment_intent',
      note           = v_before ->> 'note',
      guest_name     = v_before ->> 'guest_name',
      table_label    = v_before ->> 'table_label',
      is_dining_in   = (v_before ->> 'is_dining_in')::boolean,
      room_number    = v_before ->> 'room_number',
      total          = (v_before ->> 'total')::numeric(10,2)
    where id = p_order_id;

    delete from order_items where order_id = p_order_id;
    insert into order_items (order_id, menu_item_id, item_name, qty, unit_price, line_total)
    select p_order_id,
           (e ->> 'menu_item_id')::uuid, e ->> 'item_name',
           (e ->> 'qty')::int, (e ->> 'unit_price')::numeric(10,2),
           (e ->> 'line_total')::numeric(10,2)
    from jsonb_array_elements(v_before -> 'items') e;
  end if;

  -- The entry stays in the log either way: a vetoed edit is part of the
  -- history of the order, not something to erase.
  v_entry := v_entry
    || jsonb_build_object(
         'review', case when p_approve then 'approved' else 'vetoed' end,
         'reviewed_by', v_staff.name,
         'reviewed_at', to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD"T"HH24:MI:SS'));

  update orders set edit_log = jsonb_set(edit_log, array[v_idx::text], v_entry)
   where id = p_order_id;

  return jsonb_build_object('ok', true, 'review', v_entry ->> 'review');
end;
$$;

revoke all on function public.review_order_edit(uuid, text, boolean) from public;
grant execute on function public.review_order_edit(uuid, text, boolean) to authenticated;
