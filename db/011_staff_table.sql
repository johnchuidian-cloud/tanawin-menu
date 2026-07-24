-- Staff roster moves from the hard-coded config.js list into a table so
-- admins can add/remove people from the dashboard. Each staff row maps to
-- a Supabase Auth user (email <slug>@tanawin.menu, password
-- "tanawin-menu-v1:<PIN>"); the PIN itself lives only in GoTrue, never here.
-- Writes happen only through the admin-gated manage-staff Edge Function
-- (service role) — no client write policies exist.

create table public.staff (
  slug text primary key,
  name text not null,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  is_active boolean not null default true,
  auth_uid uuid not null,
  sort_order int not null default 0,
  created_at timestamptz default now()
);

alter table public.staff enable row level security;
-- login picker (pre-auth) needs the names/slugs/roles; PINs are not here.
create policy "anon read active staff" on public.staff
  for select to anon using (is_active);
create policy "auth read staff" on public.staff
  for select to authenticated using (true);

insert into public.staff (slug, name, role, auth_uid, sort_order) values
  ('lexi',    'Lexi',    'admin', 'c9dafc61-6696-478a-bc69-17f0f132c1be', 0),
  ('monique', 'Monique', 'staff', '8133d44b-7486-4509-8921-b974d37def19', 1),
  ('disang',  'Disang',  'staff', '42a00962-f8d9-4c28-ba98-147024377a0b', 2),
  ('sherill', 'Sherill', 'staff', '3529ec7b-b586-4b6f-82fd-20aaebfbd851', 3),
  ('janice',  'Janice',  'staff', '564960f0-c293-4c57-a3a1-b0d499554740', 4);
