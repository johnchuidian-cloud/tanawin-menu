// Admin-only staff management. The dashboard calls this to add/remove staff
// or reset a PIN. Creating GoTrue users needs the service role, which must
// never reach the browser — so it lives here, gated on the caller proving
// they're an admin via their own login token.

import { createClient } from 'npm:@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const slugify = (name: string) =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const emailFor = (slug: string) => `${slug}@tanawin.menu`;
const passwordFor = (pin: string) => `tanawin-menu-v1:${pin}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // 1) Verify the caller is a signed-in admin, using THEIR token.
  const authHeader = req.headers.get('Authorization') ?? '';
  const asCaller = createClient(URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await asCaller.auth.getUser();
  if (authErr || !user || user.user_metadata?.role !== 'admin') {
    return json({ error: 'admins only' }, 403);
  }

  const admin = createClient(URL, SERVICE);

  // The caller's own staff row tells us if they're the prime admin (Lexi).
  const { data: callerRow } = await admin.from('staff')
    .select('slug, role, is_prime, auth_uid').eq('auth_uid', user.id).maybeSingle();
  const callerIsPrime = callerRow?.is_prime === true;

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const action = body.action;

  try {
    if (action === 'add') {
      const name = (body.name ?? '').trim();
      const role = body.role === 'admin' ? 'admin' : 'staff';
      const pin = (body.pin ?? '').trim();
      if (!name) return json({ error: 'Name is required.' }, 400);
      if (!/^\d{4}$/.test(pin)) return json({ error: 'PIN must be exactly 4 digits.' }, 400);
      if (role === 'admin' && !callerIsPrime) return json({ error: 'Only Lexi can add an admin.' }, 403);

      let slug = slugify(name);
      if (!slug) return json({ error: 'Please use letters or numbers in the name.' }, 400);
      // de-dupe the slug against existing rows
      const { data: existing } = await admin.from('staff').select('slug');
      const taken = new Set((existing ?? []).map(r => r.slug));
      if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email: emailFor(slug),
        password: passwordFor(pin),
        email_confirm: true,
        user_metadata: { name, role },
      });
      if (cErr || !created?.user) return json({ error: cErr?.message ?? 'Could not create the login.' }, 400);

      const { data: maxRow } = await admin.from('staff').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
      const { error: iErr } = await admin.from('staff').insert({
        slug, name, role, auth_uid: created.user.id, sort_order: (maxRow?.sort_order ?? 0) + 1,
      });
      if (iErr) { await admin.auth.admin.deleteUser(created.user.id); return json({ error: iErr.message }, 400); }
      return json({ ok: true, slug, name, role });
    }

    if (action === 'remove') {
      const slug = (body.slug ?? '').trim();
      const { data: row } = await admin.from('staff').select('*').eq('slug', slug).maybeSingle();
      if (!row) return json({ error: 'That staff member no longer exists.' }, 404);
      if (row.is_prime) return json({ error: 'The owner account (Lexi) can’t be removed.' }, 403);
      if (row.auth_uid === user.id) return json({ error: 'You can’t remove your own account.' }, 400);
      if (row.role === 'admin' && !callerIsPrime) return json({ error: 'Only Lexi can remove an admin.' }, 403);
      await admin.auth.admin.deleteUser(row.auth_uid);
      await admin.from('staff').delete().eq('slug', slug);
      return json({ ok: true });
    }

    // Grant or revoke admin — prime only.
    if (action === 'set_role') {
      const slug = (body.slug ?? '').trim();
      const role = body.role === 'admin' ? 'admin' : 'staff';
      if (!callerIsPrime) return json({ error: 'Only Lexi can change admin privileges.' }, 403);
      const { data: row } = await admin.from('staff').select('*').eq('slug', slug).maybeSingle();
      if (!row) return json({ error: 'That staff member no longer exists.' }, 404);
      if (row.is_prime) return json({ error: 'The owner account’s role can’t be changed.' }, 403);
      // keep the login's metadata role in sync so RLS and the UI agree
      const { error: mErr } = await admin.auth.admin.updateUserById(row.auth_uid,
        { user_metadata: { name: row.name, role } });
      if (mErr) return json({ error: mErr.message }, 400);
      const { error: rErr } = await admin.from('staff').update({ role }).eq('slug', slug);
      if (rErr) return json({ error: rErr.message }, 400);
      return json({ ok: true, role });
    }

    if (action === 'set_pin') {
      const slug = (body.slug ?? '').trim();
      const pin = (body.pin ?? '').trim();
      if (!/^\d{4}$/.test(pin)) return json({ error: 'PIN must be exactly 4 digits.' }, 400);
      const { data: row } = await admin.from('staff').select('auth_uid, role, is_prime').eq('slug', slug).maybeSingle();
      if (!row) return json({ error: 'That staff member no longer exists.' }, 404);
      // You can always change your own PIN. Otherwise: only the prime may
      // reset another admin's (or the prime's) PIN — so a second admin can't
      // hijack the owner account by resetting its PIN.
      const isSelf = row.auth_uid === user.id;
      if (!isSelf && (row.is_prime || row.role === 'admin') && !callerIsPrime) {
        return json({ error: 'Only Lexi can reset an admin’s PIN.' }, 403);
      }
      const { error: uErr } = await admin.auth.admin.updateUserById(row.auth_uid, { password: passwordFor(pin) });
      if (uErr) return json({ error: uErr.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong.' }, 500);
  }
});
