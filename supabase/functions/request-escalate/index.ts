// Tanawin Menu — escalate ignored guest requests.
//
// A guest request that sits unacknowledged for 10 minutes gets an URGENT push
// to every staff device, then stamps escalated_at so it never nags twice.
// Called on a schedule (pg_cron, every 3 min — see db/019), not by a trigger,
// because the whole point is the passage of time with nothing happening.
//
// SMS escalation is what Lexi eventually wants; that needs a funded provider,
// so this is push-only for now.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const STALE_MINUTES = 10;

// Fallbacks only — the real values live in concierge_content/request_config so
// Lexi can change the hours herself from the Concierge editor.
const DEFAULT_HOURS = { open: '07:00', last_call_weekday: '18:00', last_call_weekend: '20:00' };

// Manila wall-clock, since that's what "staff are back at 7" means to a guest.
function manilaNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Manila', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(p => [p.type, p.value]),
  );
  return { hhmm: `${parts.hour}:${parts.minute}`, weekday: parts.weekday };
}

// Are staff on shift right now? Zero-padded HH:MM compares correctly as text.
function withinStaffHours(cfg: Record<string, string>) {
  const { hhmm, weekday } = manilaNow();
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  const close = (weekend ? cfg.last_call_weekend : cfg.last_call_weekday)
    ?? DEFAULT_HOURS.last_call_weekday;
  const open = cfg.open ?? DEFAULT_HOURS.open;
  // NOTE: must be bounded at BOTH ends. "past opening" alone is also true at
  // 11pm, which is exactly the 3am alert this is meant to prevent.
  return { on: hhmm >= open && hhmm < close, hhmm, open, close };
}

const KIND_LABEL: Record<string, string> = {
  towel_change: 'Towel change',
  bin_clearing: 'Bin clearing',
  room_items: 'Room items',
  problem: 'Problem report',
};

Deno.serve(async (req) => {
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('ORDER_WEBHOOK_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const cutoff = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();

  // A guest who requests at 11pm is told staff resume at 7am. Escalating that
  // 10 minutes later would wake the whole team for something the guest was
  // promised would wait — so overnight work holds until staff are back on, and
  // then escalates normally (an unacked towel from 2am nudges the morning
  // shift at ~07:10). Anything raised DURING hours is unaffected.
  const { data: cfgRow } = await db.from('concierge_content')
    .select('value').eq('key', 'request_config').maybeSingle();
  const cfg = { ...DEFAULT_HOURS, ...(cfgRow?.value ?? {}) } as Record<string, string>;
  const shift = withinStaffHours(cfg);

  const [reqRes, ordRes] = await Promise.all([
    db.from('concierge_requests')
      .select('id, kind, room_name, created_at, out_of_hours')
      .eq('status', 'new').is('acknowledged_at', null).is('escalated_at', null)
      .lt('created_at', cutoff),
    // Food orders escalate too: 'new' means nobody has tapped "Start prepping".
    // Orders carry no out_of_hours flag (nothing stops a guest ordering at 2am),
    // so the shift window is the only guard they get.
    db.from('orders')
      .select('id, order_number, room_number, is_dining_in, total, created_at')
      .eq('status', 'new').is('escalated_at', null)
      .lt('created_at', cutoff),
  ]);

  if (reqRes.error || ordRes.error) {
    const msg = reqRes.error?.message ?? ordRes.error?.message;
    console.error('escalation query failed', msg);
    return Response.json({ error: msg }, { status: 500 });
  }

  const staleReqs = (reqRes.data ?? []).filter(r => !r.out_of_hours || shift.on);
  const staleOrders = shift.on ? (ordRes.data ?? []) : [];
  const deferred = ((reqRes.data?.length ?? 0) - staleReqs.length)
    + ((ordRes.data?.length ?? 0) - staleOrders.length);
  if (deferred) {
    console.log(`holding ${deferred} overnight item(s) — Manila ${shift.hhmm}, staff hours ${shift.open}-${shift.close}`);
  }

  const mins = (at: string) => Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  const alerts = [
    ...staleReqs.map(r => ({
      table: 'concierge_requests', id: r.id,
      title: `⚠ Still waiting: ${KIND_LABEL[r.kind] ?? 'guest request'}`,
      body: `${r.room_name} — no one has picked this up in ${mins(r.created_at)} min.`,
      tag: `escalate-${r.id}`,
    })),
    ...staleOrders.map(o => ({
      table: 'orders', id: o.id,
      title: `⚠ Order #${o.order_number} not started`,
      body: `${o.is_dining_in ? 'Dining in' : o.room_number ?? 'Room ?'} · ₱${o.total} — waiting ${mins(o.created_at)} min.`,
      tag: `escalate-order-${o.id}`,
    })),
  ];
  if (!alerts.length) return Response.json({ escalated: 0, deferred });

  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  const priv = Deno.env.get('VAPID_PRIVATE_KEY');
  const { data: subs } = await db.from('push_subscriptions').select('*');

  if (pub && priv && subs?.length) {
    webpush.setVapidDetails('mailto:tanawinbnb@gmail.com', pub, priv);
    const gone: string[] = [];
    for (const a of alerts) {
      const payload = JSON.stringify({ title: a.title, body: a.body, tag: a.tag, url: '/staff' });
      await Promise.all(subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload, { TTL: 600, urgency: 'high' },
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) gone.push(s.endpoint);
          else console.log(`escalation push failed (${status ?? '?'})`);
        }
      }));
    }
    if (gone.length) await db.from('push_subscriptions').delete().in('endpoint', gone);
  } else {
    console.log('no push subscriptions or VAPID keys — escalation recorded without alerting');
  }

  // Stamp AFTER alerting, and only these ids, so nothing escalates twice and a
  // push failure doesn't silently mark it handled.
  const at = new Date().toISOString();
  const byTable = (t: string) => alerts.filter(a => a.table === t).map(a => a.id);
  const reqIds = byTable('concierge_requests');
  const ordIds = byTable('orders');
  await Promise.all([
    reqIds.length ? db.from('concierge_requests').update({ escalated_at: at }).in('id', reqIds) : null,
    ordIds.length ? db.from('orders').update({ escalated_at: at }).in('id', ordIds) : null,
  ]);

  console.log(`escalated ${reqIds.length} request(s) + ${ordIds.length} order(s) to ${subs?.length ?? 0} device(s)`);
  return Response.json({
    escalated: alerts.length, requests: reqIds.length, orders: ordIds.length,
    deferred, devices: subs?.length ?? 0,
  });
});
