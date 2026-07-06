-- Tanawin Menu — initial schema (handoff §3–4)
-- Run once against the tanawin-menu Supabase project (ref lkeuiquqogtevsgvaddf).

-- ── Tables ────────────────────────────────────────────────────────────

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null check (category in
    ('Chicken','Seafood','Vegetables','Silogs','Crepes','Pika-Pika','Beverages')),
  description text,
  image_url text,
  price numeric(10,2) not null,
  is_available boolean not null default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity,
  room_number text,
  is_dining_in boolean not null default false,
  status text not null default 'new' check (status in ('new','preparing','delivered','cancelled')),
  payment_intent text not null check (payment_intent in ('room','gcash','cash')),
  gcash_proof_url text,
  total numeric(10,2) not null,
  note text,
  created_at timestamptz default now()
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  -- set null (not restrict) so deleting a menu item never blocks; the
  -- item_name/unit_price snapshots keep the order history intact
  menu_item_id uuid references public.menu_items(id) on delete set null,
  item_name text not null,
  qty int not null check (qty > 0),
  unit_price numeric(10,2) not null,
  line_total numeric(10,2) not null
);

create table public.settings (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

insert into public.settings (key, value) values
  ('staff_sms_numbers', ''),
  ('gcash_qr_url', ''),
  ('sms_enabled', 'false');

-- ── RLS ───────────────────────────────────────────────────────────────

alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.settings enable row level security;

-- menu_items: guests see available items; staff full CRUD
create policy "anon read available items" on public.menu_items
  for select to anon using (is_available);
create policy "staff read all items" on public.menu_items
  for select to authenticated using (true);
create policy "staff insert items" on public.menu_items
  for insert to authenticated with check (true);
create policy "staff update items" on public.menu_items
  for update to authenticated using (true);
create policy "staff delete items" on public.menu_items
  for delete to authenticated using (true);

-- orders: guests insert only; staff read/update (no delete — use 'cancelled')
create policy "anon place order" on public.orders
  for insert to anon with check (true);
create policy "staff read orders" on public.orders
  for select to authenticated using (true);
create policy "staff update orders" on public.orders
  for update to authenticated using (true);

-- order_items: guests insert only; staff read
create policy "anon insert order items" on public.order_items
  for insert to anon with check (true);
create policy "staff read order items" on public.order_items
  for select to authenticated using (true);

-- settings: staff only (anon never reads this table; the GCash QR is
-- served as a public asset in menu-images instead — handoff §8 decision)
create policy "staff read settings" on public.settings
  for select to authenticated using (true);
create policy "staff insert settings" on public.settings
  for insert to authenticated with check (true);
create policy "staff update settings" on public.settings
  for update to authenticated using (true);

-- ── Storage buckets ───────────────────────────────────────────────────

insert into storage.buckets (id, name, public) values
  ('menu-images', 'menu-images', true),
  ('gcash-proofs', 'gcash-proofs', false);

create policy "public read menu images" on storage.objects
  for select to anon, authenticated using (bucket_id = 'menu-images');
create policy "staff write menu images" on storage.objects
  for insert to authenticated with check (bucket_id = 'menu-images');
create policy "staff update menu images" on storage.objects
  for update to authenticated using (bucket_id = 'menu-images');
create policy "staff delete menu images" on storage.objects
  for delete to authenticated using (bucket_id = 'menu-images');

create policy "anon upload gcash proof" on storage.objects
  for insert to anon with check (bucket_id = 'gcash-proofs');
create policy "staff read gcash proofs" on storage.objects
  for select to authenticated using (bucket_id = 'gcash-proofs');

-- ── Realtime ──────────────────────────────────────────────────────────
-- Staff dashboard subscribes to new/updated orders.

alter publication supabase_realtime add table public.orders;
