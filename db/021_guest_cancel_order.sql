-- Let a guest cancel their own order (feedback: cancelling was staff-only, so a
-- guest who tapped by mistake had to go find someone).
--
-- Same shape as the guest status peephole: guests still cannot read or write
-- the orders table, and the order's unguessable uuid — handed back only to the
-- phone that placed it — is the claim ticket.
--
-- ONLY while the order is still 'new'. Once the kitchen has started prepping,
-- food is being cooked and cancelling is a conversation with staff, not a
-- button. The refusal says so rather than failing silently.
--
-- cancelled_by records 'Guest' so the dashboard's audit trail doesn't imply a
-- staff member did it.

create or replace function public.cancel_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from orders where id = p_order_id;

  if v_status is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_status = 'cancelled' then                       -- double tap, or already gone
    return jsonb_build_object('ok', true, 'status', 'cancelled');
  end if;

  if v_status <> 'new' then
    return jsonb_build_object('ok', false, 'reason', 'already_started', 'status', v_status);
  end if;

  update orders
     set status = 'cancelled',
         cancelled_by = 'Guest'
   where id = p_order_id
     and status = 'new';                               -- re-check: staff may have tapped meanwhile

  if not found then
    select status into v_status from orders where id = p_order_id;
    return jsonb_build_object('ok', false, 'reason', 'already_started', 'status', v_status);
  end if;

  return jsonb_build_object('ok', true, 'status', 'cancelled');
end;
$$;

revoke all on function public.cancel_order(uuid) from public;
grant execute on function public.cancel_order(uuid) to anon, authenticated;
