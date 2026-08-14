-- Staff can step a mis-tapped order status back — without the guest seeing it.
--
-- Two separate truths from here on:
--   orders.status            — where the order really is, what staff act on
--   orders.status_high_water — the furthest it has ever got, what the guest sees
--
-- Why: "Delivered ✓" gets tapped on the wrong card, and the only way back was
-- to cancel and uncancel, which wiped the trail and told the guest their food
-- was cancelled. But a guest who has already read "on the way" must never see
-- it drop back to "being prepped" — that reads as the food being un-cooked.
-- So the guest tracker holds the high-water mark; cancellation stays the one
-- backwards move a guest is shown, because that one they need to know about.
--
-- Maintained by a trigger rather than by the client, so it holds no matter
-- which surface writes the row (dashboard, RPC, or a psql fix at 2am).

alter table public.orders
  add column if not exists status_high_water text not null default 'new';

create or replace function public.order_status_rank(s text)
returns int
language sql
immutable
set search_path = public
as $$
  select case s
    when 'new'        then 1
    when 'preparing'  then 2
    when 'on_the_way' then 3
    when 'delivered'  then 4
    else 0                      -- 'cancelled' never raises the mark
  end;
$$;

create or replace function public.keep_status_high_water()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if order_status_rank(new.status) > order_status_rank(new.status_high_water) then
    new.status_high_water := new.status;
  else
    -- Ratchet: a step back leaves the mark exactly where it was.
    new.status_high_water := old.status_high_water;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_status_high_water on public.orders;
create trigger orders_status_high_water
  before update of status on public.orders
  for each row execute function public.keep_status_high_water();

-- Existing rows: whatever they reached is where they are. Cancelled rows have
-- no recoverable pre-cancel status and are historical, so they start at 'new'.
update public.orders
   set status_high_water = case when status = 'cancelled' then 'new' else status end
 where status_high_water = 'new' and status <> 'new';

-- The guest peephole now reports the high-water mark. Cancellation is the
-- exception: it's shown as itself, since the guest has to know.
create or replace function public.get_order_status(p_order_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'order_number', o.order_number,
    'status', case when o.status = 'cancelled' then 'cancelled' else o.status_high_water end,
    'created_at', o.created_at
  )
  from orders o
  where o.id = p_order_id;
$$;

revoke all on function public.get_order_status(uuid) from public;
grant execute on function public.get_order_status(uuid) to anon, authenticated;

-- Plate collection has to agree with what the guest was shown. If staff step
-- 'delivered' back, the guest's tracker still offers the button (high-water
-- rule) — refusing it there with "not_delivered" would be the app calling the
-- guest a liar about a meal they've just finished.
create or replace function public.request_plate_collection(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  record;
  v_room   text;
  v_note   text;
  v_cfg    jsonb;
  v_now    time;
  v_dow    int;
  v_close  time;
  v_ooh    boolean;
begin
  select id, order_number, status, status_high_water, room_number, is_dining_in, access_room
    into v_order
    from orders where id = p_order_id;

  if v_order.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Only once the food has actually been handed over — judged by what the
  -- guest was shown, not by a status staff have since stepped back.
  if v_order.status = 'cancelled' or v_order.status_high_water <> 'delivered' then
    return jsonb_build_object('ok', false, 'reason', 'not_delivered', 'status', v_order.status);
  end if;

  v_room := coalesce(nullif(btrim(coalesce(v_order.room_number, '')), ''),
                     v_order.access_room, 'Unknown room');
  v_note := 'Plates from order #' || v_order.order_number;

  -- Tapping twice shouldn't queue two collections.
  if exists (
    select 1 from concierge_requests
     where kind = 'plate_collection'
       and note = v_note
       and status in ('new', 'acknowledged')
  ) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  -- Same out-of-hours rule Concierge applies, so the overnight hold and the
  -- 🌙 badge behave identically for these.
  select value into v_cfg from concierge_content where key = 'request_config';
  v_now := (now() at time zone 'Asia/Manila')::time;
  v_dow := extract(isodow from (now() at time zone 'Asia/Manila'));
  v_close := case when v_dow in (6, 7)
                  then coalesce((v_cfg->>'last_call_weekend')::time, '20:00'::time)
                  else coalesce((v_cfg->>'last_call_weekday')::time, '18:00'::time) end;
  v_ooh := not (v_now >= coalesce((v_cfg->>'open')::time, '07:00'::time) and v_now < v_close);

  insert into concierge_requests (room_name, kind, note, out_of_hours)
  values (v_room, 'plate_collection', v_note, v_ooh);

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.request_plate_collection(uuid) from public;
grant execute on function public.request_plate_collection(uuid) to anon, authenticated;
