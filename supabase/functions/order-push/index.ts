// Tanawin Menu — web push on new orders.
// Invoked by the same pg_net trigger as order-sms (see db/016_order_push_webhook.sql).
//
// Unlike SMS this costs nothing per alert, but it only reaches a device that
// (a) installed the dashboard / granted permission and (b) currently has a
// working data connection. SMS stays the fallback for dead WiFi.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

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

  const order = await req.json();
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: subs } = await db.from('push_subscriptions').select('*');
  if (!subs?.length) {
    console.log(`no push subscriptions — order #${order.order_number} not pushed`);
    return Response.json({ sent: 0 });
  }

  const where = order.is_dining_in ? 'Dining in' : `Room ${order.room_number ?? '?'}`;
  const payload = JSON.stringify({
    title: `New order #${order.order_number}`,
    body: `${where} · ₱${order.total}`,
    tag: `order-${order.order_id}`,
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

  console.log(`order #${order.order_number}: pushed to ${ok.length}/${subs.length} device(s)`);
  return Response.json({ sent: ok.length, pruned: gone.length });
});
