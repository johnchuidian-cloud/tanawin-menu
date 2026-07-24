-- Prime admin: Lexi is the protected owner account. She can't be removed or
-- demoted by anyone (not even another admin like Rio), and only she can grant
-- or revoke admin privileges. Enforced in the manage-staff Edge Function; this
-- flag is the source of truth.

alter table public.staff add column if not exists is_prime boolean not null default false;

update public.staff set is_prime = true where slug = 'lexi';
