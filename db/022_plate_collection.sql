-- "Done with my food — please collect my plates."
--
-- Guests eating in their room had no way to say they'd finished, so trays sat
-- until someone happened to pass. This adds a 5th request kind and an RPC the
-- Menu order-tracker calls.
--
-- Why a Menu-side RPC rather than concierge_submit_request: that one takes a
-- room access code and whitelists its own four kinds. Here the guest has
-- ALREADY proved which room they are by placing the order, so the order's
-- unguessable uuid is the claim ticket — same pattern as get_order_status and
-- cancel_order, and no code re-entry.
--
-- Concierge's RPC is unaffected: its own whitelist simply never accepts this
-- kind, which is correct.

alter table public.concierge_requests drop constraint if exists concierge_requests_kind_check;
alter table public.concierge_requests add constraint concierge_requests_kind_check
  check (kind in ('towel_change', 'bin_clearing', 'room_items', 'problem', 'plate_collection'));

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
  select id, order_number, status, room_number, is_dining_in, access_room
    into v_order
    from orders where id = p_order_id;

  if v_order.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Only once the food has actually been handed over.
  if v_order.status <> 'delivered' then
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
