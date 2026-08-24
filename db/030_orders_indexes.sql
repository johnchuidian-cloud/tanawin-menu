-- Indexes the dashboard has always needed and never had.
--
-- 29 migrations in and `orders` had no index on created_at at all, so every
-- date-range load, every export and every month aggregate was a sequential
-- scan plus a sort. `order_items.order_id` was unindexed too — Postgres does
-- NOT index foreign keys automatically, only the primary key side — so each
-- order-with-items read scanned that table as well.
--
-- Invisible at 27 orders. The point is that they stay invisible at 27,000,
-- and they are what make the month archive fast rather than merely correct.
--
-- DESC because every read here is newest-first; Postgres can walk an index
-- backwards, but matching the actual sort order keeps the plan honest.

create index if not exists orders_created_idx on public.orders (created_at desc);
create index if not exists order_items_order_idx on public.order_items (order_id);
