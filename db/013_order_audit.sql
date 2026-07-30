-- Order audit trail: who fulfilled, who cancelled (shown on staff cards).
alter table public.orders add column if not exists handled_by text;
alter table public.orders add column if not exists cancelled_by text;
