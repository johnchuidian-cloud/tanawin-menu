// Tanawin Menu — SMS nudge on new orders (handoff §7).
// Invoked by a pg_net trigger on orders INSERT (see db/003_order_webhook.sql).
// Launch state: sms_enabled=false in settings → logs and returns (the stub).
// Flip the settings toggle + fund Semaphore + set SEMAPHORE_API_KEY to go live.

import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  // Deployed with JWT verification off so the DB trigger can call it;
  // a shared secret keeps strangers out instead.
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('ORDER_WEBHOOK_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }

  const order = await req.json();
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: settings } = await db.from('settings')
    .select('key, value').in('key', ['sms_enabled', 'staff_sms_numbers']);
  const conf = Object.fromEntries((settings ?? []).map(r => [r.key, r.value]));

  const { count } = await db.from('order_items')
    .select('*', { count: 'exact', head: true }).eq('order_id', order.order_id);

  const where = order.is_dining_in ? 'Dining in' : `Room ${order.room_number}`;
  const message = `New order #${order.order_number} — ${where} — P${order.total}. ${count ?? '?'} items. Open dashboard.`;

  if (conf.sms_enabled !== 'true') {
    console.log(`[stub] SMS disabled. Would send: "${message}" to [${conf.staff_sms_numbers ?? ''}]`);
    return Response.json({ sent: false, stub: true, message });
  }

  const numbers = (conf.staff_sms_numbers ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const apiKey = Deno.env.get('SEMAPHORE_API_KEY');
  if (!numbers.length || !apiKey) {
    console.log(`SMS enabled but ${!apiKey ? 'SEMAPHORE_API_KEY missing' : 'no staff numbers set'} — skipped: "${message}"`);
    return Response.json({ sent: false, message });
  }

  const resp = await fetch('https://api.semaphore.co/api/v4/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apikey: apiKey,
      number: numbers.join(','),
      message,
      sendername: 'TANAWIN',
    }),
  });
  console.log(`semaphore responded ${resp.status} for order #${order.order_number}`);
  return Response.json({ sent: resp.ok, message });
});
