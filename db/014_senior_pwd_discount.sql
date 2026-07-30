-- Senior citizen / PWD discount (RA 9994 / RA 10754), applied by staff at billing.
-- Tanawin is NOT VAT-registered, so the discount is a flat 20% of the eligible
-- diners' proportionate share of the bill — no VAT-exemption step (never /1.12).
-- Recorded on the order row because PH law requires keeping a record of granted
-- discounts; flows into the staff Excel export.

alter table public.orders add column if not exists discount_diners int;
alter table public.orders add column if not exists discount_eligible int;
alter table public.orders add column if not exists discount_amount numeric(10,2);
alter table public.orders add column if not exists discount_by text; -- staff name, audit trail (matches handled_by/cancelled_by)
