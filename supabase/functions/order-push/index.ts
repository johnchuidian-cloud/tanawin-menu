// Tanawin Menu — web push on new orders AND new guest requests.
// Invoked by two pg_net triggers: the orders one it shares with order-sms
// (db/016), and the concierge_requests one (db/023). Kept as one function
// rather than two so the VAPID setup, the dead-subscription pruning and the
// last_success_at bookkeeping have a single proven code path.
//
// Unlike SMS this costs nothing per alert, but it only reaches a device that
// (a) installed the dashboard / granted permission and (b) currently has a
// working data connection. SMS stays the fallback for dead WiFi.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const KIND_LABEL: Record<string, string> = {
  towel_change: 'Towel change',
  bin_clearing: 'Bin clearing',
  room_items: 'Room items',
  problem: 'Problem report',
  plate_collection: 'Plate collection',
};

// Fallbacks only — the real hours live in concierge_content/request_config so
// Lexi can change them herself. Twin of the helper in request-escalate.
const DEFAULT_HOURS = { open: '07:00', last_call_weekday: '18:00', last_call_weekend: '20:00' };

// Manila wall-clock, since that's what "staff are back at 7" means to a guest.
function withinStaffHours(cfg: Record<string, string>) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Manila', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(p => [p.type, p.value]),
  );
  const hhmm = `${parts.hour}:${parts.minute}`;
  const weekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';
  const open = cfg.open ?? DEFAULT_HOURS.open;
  const close = (weekend ? cfg.last_call_weekend : cfg.last_call_weekday)
    ?? DEFAULT_HOURS.last_call_weekday;
  // Bounded at BOTH ends: "past opening" alone is also true at 11pm.
  return { on: hhmm >= open && hhmm < close, hhmm, open, close };
}

Deno.serve(async (req) => {
  // JWT verification is off so the DB trigger can call in; shared secret gates it.
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('ORDER_WEBHOOK_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }

  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  const priv = Deno.env.get('VAPID_PRIVATE_KEY');
  if (!pub || !priv) {
    console.log('VAPID keys missing — push skipped');
    return Response.json({ sent: 0, reason: 'no-vapid-keys' });
  }
  webpush.setVapidDetails('mailto:tanawinbnb@gmail.com', pub, priv);

  const event = await req.json();
  const isRequest = typeof event.kind === 'string';   // requests carry a kind, orders don't
  const label = isRequest ? `request ${event.request_id}` : `order #${event.order_number}`;

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // A guest who asks at 11pm is told staff resume at 7am; buzzing every phone
  // straight away breaks that promise in the noisiest possible way. Held
  // requests aren't lost — request-escalate picks them up once staff are back.
  // Orders are unaffected: nothing stops a guest ordering food at 2am, and the
  // kitchen alert chain is what tells them nobody's there.
  if (isRequest) {
    const { data: cfgRow } = await db.from('concierge_content')
      .select('value').eq('key', 'request_config').maybeSingle();
    const cfg = { ...DEFAULT_HOURS, ...(cfgRow?.value ?? {}) } as Record<string, string>;
    const shift = withinStaffHours(cfg);
    if (event.out_of_hours || !shift.on) {
      console.log(`holding ${label} — Manila ${shift.hhmm}, staff hours ${shift.open}-${shift.close}`);
      return Response.json({ sent: 0, held: true });
    }
  }

  const { data: subs } = await db.from('push_subscriptions').select('*');
  if (!subs?.length) {
    console.log(`no push subscriptions — ${label} not pushed`);
    return Response.json({ sent: 0 });
  }

  const payload = JSON.stringify(isRequest
    ? {
        title: `New request: ${KIND_LABEL[event.kind] ?? 'guest request'}`,
        body: [event.room_name, event.note].filter(Boolean).join(' — '),
        tag: `request-${event.request_id}`,
        url: '/staff',
      }
    : {
        title: `New order #${event.order_number}`,
        body: `${event.is_dining_in ? 'Dining in' : `Room ${event.room_number ?? '?'}`} · ₱${event.total}`,
        tag: `order-${event.order_id}`,
        url: '/staff',
      });

  const ok: string[] = [];
  const gone: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 900 },   // a 15-min-old order alert is just noise
      );
      ok.push(s.endpoint);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410 = the browser threw the subscription away (app removed,
      // permission revoked). Anything else is transient — keep the row.
      if (status === 404 || status === 410) gone.push(s.endpoint);
      else console.log(`push failed (${status ?? 'no status'}) for ${s.endpoint.slice(0, 40)}…`);
    }
  }));

  if (gone.length) {
    await db.from('push_subscriptions').delete().in('endpoint', gone);
    console.log(`pruned ${gone.length} dead subscription(s)`);
  }
  if (ok.length) {
    await db.from('push_subscriptions')
      .update({ last_success_at: new Date().toISOString() }).in('endpoint', ok);
  }

  console.log(`${label}: pushed to ${ok.length}/${subs.length} device(s)`);
  return Response.json({ sent: ok.length, pruned: gone.length });
});
