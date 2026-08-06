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
  const { data: stale, error } = await db.from('concierge_requests')
    .select('id, kind, room_name, created_at')
    .eq('status', 'new')
    .is('acknowledged_at', null)
    .is('escalated_at', null)
    .lt('created_at', cutoff);

  if (error) {
    console.error('escalation query failed', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!stale?.length) return Response.json({ escalated: 0 });

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
  return Response.json({ escalated: ids.length, devices: subs?.length ?? 0 });
});
