-- 033 — close the direct anon write path on orders.
--
-- WHY
-- Since day one, `orders` and `order_items` have carried an INSERT policy for
-- the anon role with `with check (true)`. Every order in the app goes through
-- place_order() or place_manual_order(), which are SECURITY DEFINER and
-- recompute the total from the live menu — but the open policy means a client
-- could POST straight to /rest/v1/orders with a total of its own choosing and
-- skip that pricing entirely. The global rule this closes: "an RPC that
-- recomputes is only as good as the policies around it — when you add a
-- security-definer write path, revoke the direct one in the same migration."
--
-- SAFE BECAUSE
--   * Nothing in the app inserts into either table directly. Verified against
--     the code: the only .insert() calls anywhere are on categories and
--     menu_items. Order creation is exclusively via the two RPCs.
--   * Both RPCs are SECURITY DEFINER owned by postgres, so they bypass RLS
--     altogether. Dropping a policy cannot affect them.
--   * SELECT and UPDATE policies are untouched — the staff dashboard keeps
--     reading and updating exactly as before.

drop policy if exists "anon place order"       on public.orders;
drop policy if exists "anon insert order items" on public.order_items;

-- Also anon EXECUTE on the three staff-only order functions. Each one already
-- gates inside its body (`select ... from staff where auth_uid = auth.uid()
-- and is_active; if not found then raise exception 'not authorised'`), so this
-- is not an open door — it is the second half of the rule that says keep the
-- gate in the body AND revoke the grant, so that neither alone has to hold.
--
-- `revoke ... from public` would NOT do this: Supabase grants EXECUTE to anon,
-- authenticated and service_role BY NAME at creation, and a PUBLIC revoke
-- leaves those standing. It has to name anon.
--
-- ⚠️ CREATE OR REPLACE RE-APPLIES THE DEFAULT GRANTS. Any future migration that
-- replaces one of these functions must repeat its revoke, or the hole reopens
-- silently.
revoke all on function public.edit_order(uuid, text, text, text, text, text, boolean, text, jsonb) from anon;
revoke all on function public.place_manual_order(text, boolean, text, text, jsonb, text, text, text, text, text, boolean, timestamptz) from anon;
revoke all on function public.review_order_edit(uuid, text, boolean) from anon;

-- Deliberately NOT touched: place_order, cancel_order, get_order_status and
-- request_plate_collection must stay anon-callable — those are the guest app.
-- Trigger functions (notify_order_sms, notify_request_push, order_snapshot and
-- friends) are also left alone: revoking there is cosmetic at best and risks
-- the guest ordering path, which is not a trade worth making blind.

-- ── ROLLBACK, if guest ordering breaks ────────────────────────────────────
-- create policy "anon place order" on public.orders
--   for insert to anon with check (true);
-- create policy "anon insert order items" on public.order_items
--   for insert to anon with check (true);
-- grant execute on function public.edit_order(uuid, text, text, text, text, text, boolean, text, jsonb) to anon;
-- grant execute on function public.place_manual_order(text, boolean, text, text, jsonb, text, text, text, text, text, boolean, timestamptz) to anon;
-- grant execute on function public.review_order_edit(uuid, text, boolean) to anon;
