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
  const { data: rows, error } = await db.from('concierge_requests')
    .select('id, kind, room_name, created_at, out_of_hours')
    .eq('status', 'new')
    .is('acknowledged_at', null)
    .is('escalated_at', null)
    .lt('created_at', cutoff);

  if (error) {
    console.error('escalation query failed', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!rows?.length) return Response.json({ escalated: 0 });

  // A guest who requests at 11pm is told staff resume at 7am. Escalating that
  // 10 minutes later would wake the whole team for something the guest was
  // promised would wait — so overnight requests hold until staff are back on,
  // and then escalate normally (an unacked towel from 2am nudges the morning
  // shift at ~07:10). Requests made DURING hours are unaffected.
  const { data: cfgRow } = await db.from('concierge_content')
    .select('value').eq('key', 'request_config').maybeSingle();
  const cfg = { ...DEFAULT_HOURS, ...(cfgRow?.value ?? {}) } as Record<string, string>;
  const shift = withinStaffHours(cfg);

  const stale = rows.filter(r => !r.out_of_hours || shift.on);
  const deferred = rows.length - stale.length;
  if (deferred) {
    console.log(`holding ${deferred} overnight request(s) — Manila ${shift.hhmm}, staff hours ${shift.open}-${shift.close}`);
  }
  if (!stale.length) return Response.json({ escalated: 0, deferred });

  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  const priv = Deno.env.get('VAPID_PRIVATE_KEY');
  const { data: subs } = await db.from('push_subscriptions').select('*');

  if (pub && priv && subs?.length) {
    webpush.setVapidDetails('mailto:tanawinbnb@gmail.com', pub, priv);
    const gone: string[] = [];
    for (const r of stale) {
      const mins = Math.round((Date.now() - new Date(r.created_at).getTime()) / 60_000);
      const payload = JSON.stringify({
        title: `⚠ Still waiting: ${KIND_LABEL[r.kind] ?? 'guest request'}`,
        body: `${r.room_name} — no one has picked this up in ${mins} min.`,
        tag: `escalate-${r.id}`,
        url: '/staff',
      });
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

  // Stamp AFTER alerting, and only these ids, so a request can't be escalated
  // twice and a push failure doesn't silently mark it handled.
  const ids = stale.map(r => r.id);
  await db.from('concierge_requests')
    .update({ escalated_at: new Date().toISOString() }).in('id', ids);

  console.log(`escalated ${ids.length} request(s) to ${subs?.length ?? 0} device(s)`);
  return Response.json({ escalated: ids.length, deferred, devices: subs?.length ?? 0 });
});
