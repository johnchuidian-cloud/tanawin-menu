// Tanawin Menu — staff dashboard logic.
//
// This page is left open for hours at a time, which is why js/update-check.js
// rides alongside it: without that, a shift can run all day on the build it
// happened to load at 7am. That check hashes this file among others, so any
// change here — including this comment — is what a stale dashboard notices.

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const FLOWER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><g transform="translate(16 16)"><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(45)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(90)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(135)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(180)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(225)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(270)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(315)"/><circle r="2.9"/></g></svg>`;
document.querySelectorAll('[data-flower]').forEach(el => { el.innerHTML = FLOWER_SVG; });

const $ = id => document.getElementById(id);

const state = {
  orders: new Map(),      // id -> order row (with items)
  requests: new Map(),    // id -> concierge_requests row (guest service requests)
  filter: 'active',
  kind: 'all',            // feed narrowing: all | order | request
  menu: [],
  categories: CATEGORIES, // replaced by the categories table on load
  editingId: null,        // menu item being edited (null = new)
  dateRange: null,        // {from, to} = showing past orders instead of recent
  pendingPhoto: null,     // File chosen in the edit sheet
  photoRemoved: false,
  channel: null,
};

// Options may be plain strings ("Hot") or priced ({label:"for 2", price:479}).
const normalizeOptions = m => !Array.isArray(m?.options) ? [] :
  m.options.map(o => typeof o === 'string' ? { label: o, price: null } : { label: o.label, price: o.price ?? null });

// ── Auth ────────────────────────────────────────────────────────────

async function boot() {
  await renderUserList();
  const { data: { session } } = await db.auth.getSession();
  session ? showApp(session.user) : showLogin();
}

function showLogin() {
  $('loginView').classList.remove('hidden');
  $('appView').classList.add('hidden');
  pickUser(null);
}

async function showApp(user) {
  const meta = user?.user_metadata || {};
  currentRole = meta.role || 'staff';
  currentName = meta.name || 'Staff';
  currentAuthId = user?.id || null;
  $('currentUserName').textContent = meta.name || '';
  const isAdmin = meta.role === 'admin';
  if (isAdmin) {
    const { data: me } = await db.from('staff').select('is_prime').eq('auth_uid', user.id).maybeSingle();
    currentIsPrime = me?.is_prime === true;
    // only the prime admin (Lexi) may create other admins
    const adminOpt = document.querySelector('#newStaffRole option[value="admin"]');
    if (adminOpt) adminOpt.hidden = !currentIsPrime;
    if (!currentIsPrime) $('newStaffRole').value = 'staff';
  }
  $('settingsTab').classList.toggle('hidden', !isAdmin);
  $('staffTab').classList.toggle('hidden', !isAdmin);
  $('olderToggle').classList.toggle('hidden', !isAdmin);   // back-editing is an admin job
  const hubLink = $('hubLink');
  hubLink.classList.remove('hidden');
  // admins get the full hub (incl. Payroll); staff get the staff launcher
  hubLink.href = isAdmin
    ? 'https://tanawin-hub.tanawinbnb.workers.dev/'
    : 'https://tanawin-hub.tanawinbnb.workers.dev/staff';
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  const tasks = [loadOrders(), loadRequests(), loadMenu(), loadRooms(), loadSettings()];
  if (isAdmin) tasks.push(loadStaff());
  await Promise.all(tasks);
  subscribeOrders();
  initAlerts();
  if (waitingCount()) startNagging(); // orders left waiting from before this sign-in
}

let currentRole = 'staff';
let currentName = 'Staff';
let currentIsPrime = false;
let currentAuthId = null;

// PIN login mirroring the Kitchen app: pick your name, enter your 4-digit
// PIN (same people, same PINs). Each person maps to a hidden auth account
// so RLS still sees `authenticated`.
let pickedUser = null;

async function renderUserList() {
  let roster = STAFF_ROSTER; // fallback if the table can't be read
  const { data, error } = await db.from('staff')
    .select('name, slug, role').order('sort_order');
  if (!error && data?.length) roster = data;
  const wrap = $('userList');
  wrap.innerHTML = '';
  roster.forEach(u => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'user-btn';
    btn.innerHTML = `
      <span class="avatar ${u.role}">${esc(u.name[0])}</span>
      <span><span class="un">${esc(u.name)}</span>
      <span class="ur">${u.role === 'admin' ? 'Admin' : 'Staff'}</span></span>`;
    btn.onclick = () => pickUser(u);
    wrap.appendChild(btn);
  });
}

function pickUser(u) {
  pickedUser = u;
  $('userPick').classList.toggle('hidden', !!u);
  $('pinStep').classList.toggle('hidden', !u);
  $('loginError').classList.add('hidden');
  $('loginPin').value = '';
  if (u) {
    $('pinWelcome').textContent = `Hi ${u.name}`;
    $('loginPin').focus();
  }
}

$('pickSomeoneElse').onclick = () => pickUser(null);

$('loginPin').oninput = async e => {
  const pin = e.target.value.replace(/\D/g, '').slice(0, 4);
  e.target.value = pin;
  $('loginError').classList.add('hidden');
  if (pin.length !== 4 || !pickedUser) return;

  const { data, error } = await db.auth.signInWithPassword({
    email: `${pickedUser.slug}@tanawin.menu`,
    password: `tanawin-menu-v1:${pin}`,
  });
  if (error) {
    $('loginPin').value = '';
    $('loginError').textContent = 'PIN incorrect — try again';
    $('loginError').classList.remove('hidden');
    return;
  }
  primeChime(); // user gesture: unlock audio for order alerts
  showApp(data.user);
};

$('logoutBtn').onclick = async () => {
  if (state.channel) db.removeChannel(state.channel);
  await db.auth.signOut();
  location.reload();
};

// ── Tabs ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    ['orders', 'menu', 'rooms', 'staff', 'settings'].forEach(t =>
      $(`tab-${t}`).classList.toggle('hidden', t !== btn.dataset.tab));
  };
});

// ── Orders: load, realtime, render ──────────────────────────────────

// state.dateRange non-null = showing a past window instead of the recent feed.
// The edit form needs unit_price to seed its picker, so it's selected here too.
async function loadOrders() {
  let q = db.from('orders')
    .select('*, order_items(item_name, qty, unit_price, line_total, menu_item_id)')
    .order('created_at', { ascending: false });

  if (state.dateRange) {
    const end = new Date(state.dateRange.to + 'T00:00:00');
    end.setDate(end.getDate() + 1);          // 'to' is inclusive
    q = q.gte('created_at', new Date(state.dateRange.from + 'T00:00:00').toISOString())
         .lt('created_at', end.toISOString())
         .limit(500);
  } else {
    q = q.limit(100);
  }

  const { data, error } = await q;
  if (error) { toast('Could not load orders.'); console.error(error); return; }
  state.orders.clear();
  data.forEach(o => state.orders.set(o.id, o));
  renderOrders();
}

// ── Reaching past orders ────────────────────────────────────────────
// The feed is the 100 most recent, which is right for a shift but useless for
// correcting a run of orders from last month. Admins get a date window.

$('olderToggle').onclick = () => {
  const panel = $('olderPanel');
  panel.classList.toggle('hidden');
  $('exportPanel').classList.add('hidden');
  $('paperPanel').classList.add('hidden');
  if (!panel.classList.contains('hidden') && !$('olderFrom').value) {
    // default to the month before this one — the usual reason to look back
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    $('olderFrom').value = iso(first);
    $('olderTo').value = iso(last);
  }
};

$('olderLoadBtn').onclick = async () => {
  const from = $('olderFrom').value, to = $('olderTo').value;
  if (!from || !to) { toast('Pick both dates first.'); return; }
  if (from > to) { toast('The "from" date is after the "to" date.'); return; }
  state.dateRange = { from, to };
  await loadOrders();
  $('olderPanel').classList.add('hidden');
  $('olderBanner').classList.remove('hidden');
  $('olderBannerText').textContent = `Showing ${from} to ${to} — ${state.orders.size} order${state.orders.size === 1 ? '' : 's'}`;
  // Old orders are finished ones, so land on the filter that shows them.
  document.querySelector('[data-filter="done"]')?.click();
};

$('olderClearBtn').onclick = async () => {
  state.dateRange = null;
  $('olderBanner').classList.add('hidden');
  await loadOrders();
  document.querySelector('[data-filter="active"]')?.click();
};

// Guest service requests from the Concierge app (shared table, suite
// connection #7). They ride the SAME feed as food orders.
async function loadRequests() {
  const { data, error } = await db
    .from('concierge_requests')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) { console.error('could not load guest requests', error); return; }
  state.requests.clear();
  data.forEach(r => state.requests.set(r.id, r));
  renderOrders();
}

function subscribeOrders() {
  if (state.channel) db.removeChannel(state.channel);
  state.channel = db.channel('orders-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, async payload => {
      // line items land in the same transaction; small delay then fetch them
      setTimeout(async () => {
        const { data } = await db.from('orders')
          .select('*, order_items(item_name, qty, line_total)')
          .eq('id', payload.new.id).single();
        if (!data) return;
        state.orders.set(data.id, data);
        renderOrders();
        // Don't alert the person who just typed it in — they're looking at the
        // screen. Other devices still get the full treatment, because a paper
        // order sent to the kitchen is news to the kitchen. (Web push is
        // suppressed for manual orders entirely, in db/027.)
        //
        // Matched on the id this device just created, not on the name:
        // entered_by comes from the staff table while currentName comes from
        // the auth metadata, and the two are free to drift apart. The time
        // window is the backstop for the realtime event arriving before the
        // RPC's reply does.
        if (data.is_manual
            && (myManualOrders.has(data.id) || Date.now() - lastManualSaveAt < 15000)) {
          myManualOrders.delete(data.id);
          return;
        }
        // Nothing to chase on an order that was already served before it was
        // recorded — the nag exists to get someone to start prepping.
        if (data.status === 'delivered') return;
        chime();
        startNagging();          // keeps chiming until someone starts prepping
        showOrderNotification(data);
        toast(`New order #${data.order_number} — ${data.is_dining_in ? 'Dining in' : 'Room ' + data.room_number}`);
      }, 600);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, payload => {
      const existing = state.orders.get(payload.new.id);
      if (existing) {
        state.orders.set(payload.new.id, { ...existing, ...payload.new });
        renderOrders();
      }
    })
    // A guest request should land as loudly as a food order.
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'concierge_requests' }, payload => {
      state.requests.set(payload.new.id, payload.new);
      renderOrders();
      chime();
      startNagging();
      showRequestNotification(payload.new);
      toast(`New request — ${REQUEST_KINDS[payload.new.kind]?.label || 'guest request'} · ${payload.new.room_name}`);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'concierge_requests' }, payload => {
      // another device acted on it — keep every dashboard in step
      state.requests.set(payload.new.id, { ...state.requests.get(payload.new.id), ...payload.new });
      renderOrders();
    })
    .subscribe();
}

// Scoped by data-attribute, NOT by ".filter-row .cat-pill" — that would also
// grab the type pills and the Excel toggle sitting in the same rows.
document.querySelectorAll('.cat-pill[data-filter]').forEach(pill => {
  pill.onclick = () => {
    state.filter = pill.dataset.filter;
    document.querySelectorAll('.cat-pill[data-filter]').forEach(p =>
      p.classList.toggle('active', p === pill));
    renderOrders();
  };
});

document.querySelectorAll('.cat-pill[data-kind]').forEach(pill => {
  pill.onclick = () => {
    state.kind = pill.dataset.kind;
    document.querySelectorAll('.cat-pill[data-kind]').forEach(p =>
      p.classList.toggle('active', p === pill));
    renderOrders();
  };
});

// an order isn't finished until it's actually been handed over
const ORDER_ACTIVE = ['new', 'preparing', 'on_the_way'];
// a request is live until someone finishes or bins it
const REQUEST_ACTIVE = ['new', 'acknowledged'];

const isOrderActive = o => ORDER_ACTIVE.includes(o.status);
const isRequestActive = r => REQUEST_ACTIVE.includes(r.status);

// Food and guest requests share one chronological feed.
function feedEntries() {
  return [
    ...[...state.orders.values()].map(o => ({ type: 'order', at: o.created_at, row: o, live: isOrderActive(o) })),
    ...[...state.requests.values()].map(r => ({ type: 'request', at: r.created_at, row: r, live: isRequestActive(r) })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
}

function renderOrders() {
  const list = $('ordersList');
  const all = feedEntries();
  const rows = all
    .filter(e => state.filter === 'active' ? e.live : !e.live)
    .filter(e => state.kind === 'all' || e.kind === state.kind || e.type === state.kind);

  const activeCount = all.filter(e => e.live).length;
  $('activeBadge').textContent = activeCount;
  $('activeBadge').classList.toggle('hidden', activeCount === 0);
  syncAlertState();

  list.innerHTML = '';
  if (!rows.length) {
    const what = state.kind === 'order' ? 'food orders' : state.kind === 'request' ? 'guest requests' : 'orders or requests';
    list.innerHTML = `<p class="empty-note">${state.filter === 'active'
      ? `No active ${what} — new ones appear here instantly.` : 'Nothing here yet.'}</p>`;
    return;
  }
  rows.forEach(e => list.appendChild(e.type === 'order' ? orderCard(e.row) : requestCard(e.row)));
}

// How long the table actually waited. Everything is counted from when the
// order was placed, because that's the number a guest experiences — the gaps
// between steps are interesting to the kitchen, but "22 minutes" is what the
// person at the table felt. Stamps come from the DB trigger (db/026), so an
// order that pre-dates it simply shows nothing rather than a fake zero.
const minsAfterOrder = (o, iso) =>
  Math.max(0, Math.round((new Date(iso) - new Date(o.created_at)) / 60000));

function timingLine(o) {
  // Not for paper orders. Their created_at is a bookkeeping figure — either
  // when staff typed it up or, when back-dated, when the meal actually
  // happened — so the gap to the first status tap measures the paperwork,
  // not the service. Order #59 read "Delivered 2776m after ordering": a tab
  // from the 16th, tapped through on the 18th. The clock times are still
  // facts and still go in the export; only this elapsed figure is a lie.
  if (o.is_manual) return '';
  const steps = [
    ['Started', o.acknowledged_at],
    ['On the way', o.on_the_way_at],
    ['Delivered', o.delivered_at],
  ].filter(([, at]) => at);
  if (!steps.length) return '';
  const clock = at => new Date(at).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  return `<div class="order-timing" title="${steps.map(([l, at]) => `${l}: ${clock(at)}`).join('\n')}">
    ⏱ ${steps.map(([l, at]) => `${l} ${minsAfterOrder(o, at)}m`).join(' · ')}
    <small>after ordering</small></div>`;
}

// Room service says which door. Dining in used to say only "Dining in", which
// is the one case where staff have to actually find someone — so name the area
// the code came from (access_room, stored since day one and never shown) and,
// when the guest gave them, their name and table.
function whereChip(o) {
  if (!o.is_dining_in) return 'Room ' + esc(o.room_number || '?');
  return o.access_room ? `Dining in · from ${esc(o.access_room)}` : 'Dining in';
}

function orderCard(o) {
  const card = document.createElement('article');
  card.className = `order-card status-${o.status}`;

  const items = (o.order_items || [])
    .map(i => `<li><span>${esc(i.item_name)} × ${i.qty}</span><span>${peso(i.line_total)}</span></li>`)
    .join('');

  // Card is the one method where money is still outstanding when the food is
  // ready, so it shouts: "unpaid" until a reference number is on the order.
  const payChip = o.payment_intent === 'room'
    ? '<span class="chip">Charge to room</span>'
    : o.payment_intent === 'gcash'
      ? '<span class="chip pay-gcash">GCash / Bank</span>'
      : o.payment_intent === 'card'
        ? `<span class="chip pay-card${o.payment_ref ? ' is-paid' : ''}">💳 Card${o.payment_ref ? ' · paid' : ' · UNPAID'}</span>`
        : '<span class="chip pay-cash">Cash</span>';

  const by = o.handled_by ? ' by ' + esc(o.handled_by) : '';
  const doneChip = o.status === 'on_the_way'
    ? `<span class="chip status-chip-otw">On the way${by}</span>`
    : o.status === 'delivered'
      ? `<span class="chip status-chip-delivered">Delivered${by}</span>`
      : o.status === 'cancelled'
        ? `<span class="chip status-chip-cancelled">Cancelled${o.cancelled_by ? ' by ' + esc(o.cancelled_by) : ''}</span>` : '';

  card.innerHTML = `
    <div class="order-top">
      <span class="order-num">#${o.order_number}</span>
      <span class="order-time">${timeLabel(o.created_at)}</span>
    </div>
    <div class="order-chips">
      <span class="chip room-chip">${whereChip(o)}</span>
      ${o.guest_name ? `<span class="chip who-chip">🙋 ${esc(o.guest_name)}</span>` : ''}
      ${o.table_label ? `<span class="chip table-chip">Table ${esc(o.table_label)}</span>` : ''}
      ${o.is_manual ? `<span class="chip paper-chip">✍ On paper${o.entered_by ? ' · ' + esc(o.entered_by) : ''}</span>` : ''}
      ${payChip}${doneChip}
    </div>
    <ul class="order-items">${items}</ul>
    ${o.note ? `<div class="order-note">📝 ${esc(o.note)}</div>` : ''}
    <div class="order-total-row"><span>Total</span><span>${peso(o.total)}</span></div>
    ${timingLine(o)}
    ${hasDiscount(o) ? `
      <div class="discount-row"><span>♿ Senior/PWD ×${o.discount_eligible} of ${o.discount_diners} diner${o.discount_diners > 1 ? 's' : ''} (−20%)</span><span>−${peso(o.discount_amount)}</span></div>
      <div class="order-total-row due-row"><span>Amount due</span><span>${peso(Number(o.total) - Number(o.discount_amount))}</span></div>` : ''}
    <div class="discount-slot"></div>
    <div class="ref-slot"></div>
    <div class="proof-slot"></div>
    <div class="edit-trail-slot"></div>
    <div class="edit-slot"></div>
    <div class="order-actions"></div>`;

  card.querySelector('.edit-trail-slot').appendChild(editTrail(o));

  // Editing is admin-only, and deliberately a full-width button rather than a
  // quiet link: Rio had to ask how to do it, and back-correcting old orders is
  // a job someone sits down to do, not a thing to be discovered by accident.
  if (currentRole === 'admin') {
    const slot = card.querySelector('.edit-slot');
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'edit-order-btn';
    openBtn.textContent = '✎ Edit this order';
    openBtn.onclick = () => {
      openBtn.classList.add('hidden');
      slot.appendChild(editOrderForm(o, () => {
        slot.innerHTML = '';
        openBtn.classList.remove('hidden');
      }));
    };
    slot.before(openBtn);
  }

  // Maya reference, typed in after the swipe. Free text and saved on blur:
  // Maya's format isn't guaranteed to stay the same, and a regex that guessed
  // wrong would block a payment that actually happened.
  if (o.payment_intent === 'card' && o.status !== 'cancelled') {
    card.querySelector('.ref-slot').appendChild(paymentRefField(o));
  }

  if (o.status !== 'cancelled') {
    const slot = card.querySelector('.discount-slot');
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'discount-btn';
    openBtn.textContent = hasDiscount(o) ? '✎ Edit Senior/PWD discount' : '♿ Senior/PWD discount…';
    openBtn.onclick = () => { openBtn.classList.add('hidden'); slot.appendChild(discountForm(o, openBtn)); };
    slot.before(openBtn);
  }

  if (o.gcash_proof_url) {
    db.storage.from('gcash-proofs').createSignedUrl(o.gcash_proof_url, 3600).then(({ data }) => {
      if (data?.signedUrl) {
        card.querySelector('.proof-slot').innerHTML =
          `<a href="${data.signedUrl}" target="_blank"><img class="proof-thumb" src="${data.signedUrl}" alt="Payment proof"></a>`;
      }
    });
  }

  if (o.signature_url) {
    db.storage.from('signatures').createSignedUrl(o.signature_url, 3600).then(({ data }) => {
      if (data?.signedUrl) {
        card.querySelector('.proof-slot').insertAdjacentHTML('beforeend',
          `<div class="sig-label">✍ Signed${o.guest_signed_name ? ' by ' + esc(o.guest_signed_name) : ''} — charge to room</div>
           <img class="sig-thumb" src="${data.signedUrl}" alt="Guest signature">`);
      }
    });
  }

  // The original slip, kept so a keyed order can always be checked against
  // what was actually written down.
  if (o.paper_url) {
    db.storage.from('paper-orders').createSignedUrl(o.paper_url, 3600).then(({ data }) => {
      if (data?.signedUrl) {
        card.querySelector('.proof-slot').insertAdjacentHTML('beforeend',
          `<div class="sig-label">📷 The paper slip</div>
           <a href="${data.signedUrl}" target="_blank" rel="noopener"><img class="proof-thumb" src="${data.signedUrl}" alt="Photo of the paper order slip"></a>`);
      }
    });
  }

  const actions = card.querySelector('.order-actions');
  if (o.status === 'new') {
    actions.appendChild(actionBtn('Start prepping', () => setStatus(o.id, 'preparing')));
    actions.appendChild(cancelBtn(o.id));
  } else if (o.status === 'preparing') {
    actions.appendChild(actionBtn('Done prepping — on the way 🛎', () => setStatus(o.id, 'on_the_way')));
    actions.appendChild(cancelBtn(o.id));
  } else if (o.status === 'on_the_way') {
    actions.appendChild(actionBtn('Delivered ✓', () => setStatus(o.id, 'delivered')));
    actions.appendChild(cancelBtn(o.id));
  } else if (o.status === 'cancelled') {
    // accidental cancels happen — any staff can bring the order back
    actions.appendChild(actionBtn('Uncancel — back to queue', () => setStatus(o.id, 'new')));
  }
  const back = ORDER_BACK[o.status];
  if (back) actions.appendChild(backBtn(back.label, () => setStatus(o.id, back.to)));
  return card;
}

// Stepping back is for a mis-tap, so it's a quiet secondary action, never
// beside the cancel button as an equal. The guest's tracker doesn't follow it
// down — the DB holds a high-water mark (db/024).
const ORDER_BACK = {
  preparing:  { to: 'new',        label: '↩ Not started after all' },
  on_the_way: { to: 'preparing',  label: '↩ Still in the kitchen' },
  delivered:  { to: 'on_the_way', label: '↩ Not delivered yet' },
};

const REQUEST_BACK = {
  acknowledged: { to: 'new',          label: '↩ Nobody has this' },
  done:         { to: 'acknowledged', label: '↩ Not finished yet' },
};

// ── Guest requests (from the Concierge app) ─────────────────────────
// Deliberately plain words, not the food lifecycle — a towel is never
// "preparing". Staff acknowledge it, then mark it done.

const REQUEST_KINDS = {
  towel_change: { label: 'Towel change', icon: '🧺' },
  bin_clearing: { label: 'Bin clearing', icon: '🗑' },
  room_items:   { label: 'Room items',   icon: '🧴' },
  problem:      { label: 'Problem report', icon: '🛠' },
  // raised from Menu's order tracker when a guest finishes eating in their room
  plate_collection: { label: 'Plate collection', icon: '🍽' },
};

function requestCard(r) {
  const card = document.createElement('article');
  card.className = `order-card request-card status-${r.status}`;
  const kind = REQUEST_KINDS[r.kind] || { label: r.kind, icon: '🛎' };

  const items = Array.isArray(r.items) && r.items.length
    ? `<ul class="order-items">${r.items.map(i => `
        <li><span>${esc(i.label || 'Item')} × ${Number(i.qty) || 1}${
          i.note ? `<small class="item-note">${esc(i.note)}</small>` : ''}</span></li>`).join('')}</ul>`
    : '';

  const stateChip = r.status === 'acknowledged'
    ? `<span class="chip status-chip-otw">Acknowledged${r.acknowledged_by ? ' by ' + esc(r.acknowledged_by) : ''}</span>`
    : r.status === 'done'
      ? `<span class="chip status-chip-delivered">Done${r.acknowledged_by ? ' by ' + esc(r.acknowledged_by) : ''}</span>`
      : r.status === 'cancelled'
        ? '<span class="chip status-chip-cancelled">Cancelled</span>' : '';

  card.innerHTML = `
    <div class="order-top">
      <span class="order-num">${kind.icon} ${esc(kind.label)}</span>
      <span class="order-time">${timeLabel(r.created_at)}</span>
    </div>
    <div class="order-chips">
      <span class="chip room-chip">${esc(r.room_name || 'Unknown room')}</span>
      <span class="chip request-chip">Guest request</span>
      ${r.out_of_hours ? '<span class="chip chip-night" title="Sent outside service hours">🌙 Overnight</span>' : ''}
      ${r.escalated_at ? '<span class="chip chip-escalated">⚠ Escalated</span>' : ''}
      ${stateChip}
    </div>
    ${items}
    ${r.note ? `<div class="order-note">📝 ${esc(r.note)}</div>` : ''}
    <div class="request-photo"></div>
    <div class="order-actions"></div>`;

  if (r.photo_data) {
    // a data URL straight from the guest's phone — never inject it as markup
    const img = document.createElement('img');
    img.className = 'request-thumb';
    img.src = r.photo_data;
    img.alt = 'Photo from the guest';
    img.onclick = () => img.classList.toggle('zoomed');
    card.querySelector('.request-photo').appendChild(img);
  }

  const actions = card.querySelector('.order-actions');
  if (r.status === 'new') {
    actions.appendChild(actionBtn('Got it — on it 👍', () => setRequestStatus(r.id, 'acknowledged')));
    actions.appendChild(requestCancelBtn(r.id));
  } else if (r.status === 'acknowledged') {
    actions.appendChild(actionBtn('Finished ✓', () => setRequestStatus(r.id, 'done')));
    actions.appendChild(requestCancelBtn(r.id));
  } else if (r.status === 'cancelled') {
    actions.appendChild(actionBtn('Put back in the queue', () => setRequestStatus(r.id, 'new')));
  }
  const back = REQUEST_BACK[r.status];
  if (back) actions.appendChild(backBtn(back.label, () => setRequestStatus(r.id, back.to)));
  return card;
}

function requestCancelBtn(id) {
  const b = document.createElement('button');
  b.className = 'btn-secondary';
  b.textContent = 'Cancel';
  b.onclick = () => { if (confirm('Cancel this guest request?')) setRequestStatus(id, 'cancelled'); };
  return b;
}

async function setRequestStatus(id, status) {
  const patch = { status };
  const now = new Date().toISOString();
  // Don't re-stamp on the way back from 'done' — whoever picked it up still did.
  if (status === 'acknowledged' && !state.requests.get(id)?.acknowledged_at) {
    patch.acknowledged_at = now; patch.acknowledged_by = currentName;
  }
  if (status === 'done') {
    patch.done_at = now;
    // acknowledging is skippable in a rush — stamp it so the record isn't half-empty
    const r = state.requests.get(id);
    if (r && !r.acknowledged_at) { patch.acknowledged_at = now; patch.acknowledged_by = currentName; }
  }
  if (status === 'new') {
    patch.acknowledged_at = null; patch.acknowledged_by = null; patch.done_at = null;
    patch.escalated_at = null;   // genuinely back in the queue, so it can nag again
  }
  // Stepping 'done' back to 'acknowledged': drop the completion stamp but keep
  // who picked it up, which is still true.
  if (status === 'acknowledged' && state.requests.get(id)?.status === 'done') patch.done_at = null;
  // .select() so we can see how many rows actually changed. This table's RLS
  // requires an ACTIVE staff row, and a blocked update returns success with
  // zero rows — without this the card would show "Done" while the request
  // stayed open in the database and on everyone else's dashboard.
  const { data, error } = await db.from('concierge_requests')
    .update(patch).eq('id', id).select('id');
  if (error) { toast('Update failed — try again.'); console.error(error); return; }
  if (!data?.length) {
    toast('Could not update that — your login may no longer be active. Sign out and back in.');
    console.error('concierge_requests update affected 0 rows (RLS?)', { id, patch });
    return;
  }
  const r = state.requests.get(id);
  if (r) { Object.assign(r, patch); renderOrders(); }
}

function actionBtn(label, fn) {
  const b = document.createElement('button');
  b.className = 'btn-primary';
  b.textContent = label;
  b.onclick = fn;
  return b;
}

function cancelBtn(id) {
  const b = document.createElement('button');
  b.className = 'btn-secondary';
  b.textContent = 'Cancel';
  b.onclick = () => { if (confirm('Cancel this order?')) setStatus(id, 'cancelled'); };
  return b;
}

// ── Editing an order (admin only) ───────────────────────────────────
// Restricted to admins on John's instruction: a total is money owed, and
// someone who can quietly drop a line from a settled tab can pocket the
// difference. Every edit needs a written reason and is kept forever.

const PAY_LABEL = { room: 'Charge to room', gcash: 'GCash / Bank', cash: 'Cash', card: 'Credit / debit card' };

// Field names as staff would say them, for the trail.
const EDIT_FIELD_LABEL = {
  payment_intent: 'Payment', note: 'Note', guest_name: 'Guest name',
  table_label: 'Table', is_dining_in: 'Location', room_number: 'Room',
  total: 'Total', items: 'Items',
};

function editValueText(field, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'payment_intent') return PAY_LABEL[v] || v;
  if (field === 'is_dining_in') return v ? 'Dining in' : 'Room service';
  if (field === 'total') return peso(v);
  if (field === 'items') {
    return Array.isArray(v) ? v.map(i => `${i.item_name} × ${i.qty}`).join(', ') : '—';
  }
  return String(v);
}

function editOrderForm(o, close) {
  const form = document.createElement('div');
  form.className = 'edit-form';
  const rooms = (state.rooms || []).filter(r => r.kind === 'room' && r.is_active);

  form.innerHTML = `
    <span class="field-label">Editing order #${o.order_number}</span>
    <fieldset class="field"><legend>Where</legend>
      <div class="pay-options edit-loc">
        <label><input type="radio" name="eloc-${o.id}" value="dining" ${o.is_dining_in ? 'checked' : ''}>
          <span><strong>Dining area</strong></span></label>
        <label><input type="radio" name="eloc-${o.id}" value="room" ${o.is_dining_in ? '' : 'checked'}>
          <span><strong>To a room</strong></span></label>
      </div>
    </fieldset>
    <label class="field edit-room ${o.is_dining_in ? 'hidden' : ''}"><span class="field-label">Which room</span>
      <select>${rooms.map(r => `<option ${r.name === o.room_number ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
    </label>
    <div class="paper-two-up">
      <label class="field"><span class="field-label">Guest name</span>
        <input type="text" class="edit-guest" maxlength="60" value="${esc(o.guest_name || '')}"></label>
      <label class="field"><span class="field-label">Table</span>
        <input type="text" class="edit-table" maxlength="20" value="${esc(o.table_label || '')}"></label>
    </div>
    <span class="field-label">Items</span>
    <div class="edit-picker-mount"></div>
    <fieldset class="field"><legend>Payment</legend>
      <div class="pay-options edit-pay">
        ${['cash', 'gcash', 'card', 'room'].map(v => `
          <label><input type="radio" name="epay-${o.id}" value="${v}" ${o.payment_intent === v ? 'checked' : ''}>
            <span><strong>${PAY_LABEL[v]}</strong></span></label>`).join('')}
      </div>
    </fieldset>
    <!-- Shown for card, because switching an old order TO card is the main
         reason anyone edits one, and the reference has to go somewhere. It was
         landing in the reason box otherwise — four orders came through that way
         before this field existed. -->
    <label class="field edit-ref-field ${o.payment_intent === 'card' ? '' : 'hidden'}">
      <span class="field-label">Maya reference number</span>
      <input type="text" class="edit-ref" maxlength="60" value="${esc(o.payment_ref || '')}"
             placeholder="From the terminal receipt"></label>
    <label class="field"><span class="field-label">Note</span>
      <input type="text" class="edit-note" maxlength="200" value="${esc(o.note || '')}"></label>
    <label class="field"><span class="field-label">Why are you changing this? <small>Required — Lexi sees this. Not the reference number.</small></span>
      <input type="text" class="edit-reason" maxlength="200" placeholder="e.g. guests actually paid by card"></label>
    <div class="order-actions">
      <button type="button" class="btn-primary edit-save">Save changes</button>
      <button type="button" class="btn-secondary edit-cancel">Cancel</button>
    </div>`;

  // Seed the picker from menu_item_id, NEVER by parsing the name apart.
  // order_items stores a snapshot like "Pancit Canton or Bihon (Canton · for 6)",
  // and a regex splitting on the last bracket looks right until an item has
  // brackets of its own: "Tinanglaran (Native Chicken in Lemongrass) (for 2)"
  // parsed out to the option "Native Chicken in Lemongrass) (for 2", which is
  // not a label on any menu row, so the server rejected the whole edit. That
  // is what made order #59 uneditable for both Lexi and Rio.
  //
  // Instead: the id says which menu row it is, and the option is whichever
  // label reconstructs the stored name exactly.
  const unresolved = [];
  const lines = (o.order_items || []).map(i => {
    const m = state.menu.find(x => x.id === i.menu_item_id);
    if (!m) { unresolved.push(i.item_name); return null; }
    const opts = Array.isArray(m.options) ? m.options : [];
    let option = null;
    for (let k = 0; k < opts.length; k++) {
      const label = typeof opts[k] === 'string' ? opts[k] : opts[k].label;
      if (i.item_name === m.name + ' (' + label + ')') { option = label; break; }
    }
    // Has options, but none of them rebuilds the stored name — re-sending it
    // would be rejected, so don't pretend we can edit the items on this order.
    if (!option && opts.length && i.item_name !== m.name) {
      unresolved.push(i.item_name);
      return null;
    }
    return { id: m.id, name: m.name, option, price: Number(i.unit_price), qty: i.qty };
  }).filter(Boolean);

  // Everything except the items stays editable when a line can't be rebuilt —
  // the RPC takes a null item list to mean "leave them alone". Rio's actual
  // need (fixing the payment method) works either way.
  const itemsEditable = unresolved.length === 0;
  let picker = null;
  if (itemsEditable) {
    picker = itemPicker(lines);
    form.querySelector('.edit-picker-mount').appendChild(picker.el);
  } else {
    form.querySelector('.edit-picker-mount').innerHTML =
      `<p class="edit-items-locked">The items on this order can’t be changed here —
       ${esc(unresolved.join(', '))} ${unresolved.length > 1 ? 'are' : 'is'} no longer
       on the menu in the same form. Everything else below can still be edited, and
       the items stay exactly as they are.</p>`;
  }

  const locRadios = form.querySelectorAll(`input[name="eloc-${o.id}"]`);
  locRadios.forEach(r => r.addEventListener('change', () => {
    const dining = form.querySelector(`input[name="eloc-${o.id}"]:checked`).value === 'dining';
    form.querySelector('.edit-room').classList.toggle('hidden', dining);
  }));

  form.querySelectorAll(`input[name="epay-${o.id}"]`).forEach(r =>
    r.addEventListener('change', () => {
      const card = form.querySelector(`input[name="epay-${o.id}"]:checked`).value === 'card';
      form.querySelector('.edit-ref-field').classList.toggle('hidden', !card);
    }));

  form.querySelector('.edit-cancel').onclick = close;

  form.querySelector('.edit-save').onclick = async () => {
    const btn = form.querySelector('.edit-save');
    const reason = form.querySelector('.edit-reason').value.trim();
    if (!reason) { toast('Please say why you are changing it.'); return; }
    if (picker && !picker.size()) { toast('An order needs at least one item.'); return; }
    const dining = form.querySelector(`input[name="eloc-${o.id}"]:checked`).value === 'dining';

    btn.disabled = true;
    btn.textContent = 'Saving…';
    const { data, error } = await db.rpc('edit_order', {
      p_order_id: o.id,
      p_reason: reason,
      p_payment_intent: form.querySelector(`input[name="epay-${o.id}"]:checked`).value,
      p_note: form.querySelector('.edit-note').value.trim() || null,
      p_guest_name: form.querySelector('.edit-guest').value.trim() || null,
      p_table_label: form.querySelector('.edit-table').value.trim() || null,
      p_is_dining_in: dining,
      p_room_name: dining ? null : form.querySelector('.edit-room select').value,
      p_items: picker ? picker.items() : null,   // null = leave the items alone
    });
    btn.disabled = false;
    btn.textContent = 'Save changes';

    if (error) {
      // Say WHICH thing went wrong. A blanket "try again" told Rio nothing and
      // told me nothing either — it hid a real bug for a day.
      console.error('edit_order failed', error);
      const m = error.message || '';
      toast(
        m.includes('only an admin') ? 'Only an admin can edit an order.'
        : m.includes('not authorised') ? 'Your login is no longer active — sign out and back in.'
        : m.includes('a reason is required') ? 'Please say why you are changing it.'
        : m.includes('item') ? "One of the items doesn't match the menu any more — tell John, don't retry."
        : m.includes('room required') ? 'Pick which room this was for.'
        : 'Could not save that change — try again.');
      return;
    }
    // The reference isn't part of edit_order — it's the same staff-authenticated
    // column the card's own field writes, so it goes the same way.
    const pay = form.querySelector(`input[name="epay-${o.id}"]:checked`).value;
    const ref = pay === 'card' ? (form.querySelector('.edit-ref').value.trim() || null) : null;
    if (ref !== (o.payment_ref || null)) {
      const { error: refErr } = await db.from('orders')
        .update({ payment_ref: ref }).eq('id', o.id).select('id');
      if (refErr) { console.error('payment_ref update failed', refErr); toast('Saved, but the reference number did not save.'); }
    }

    if (data?.unchanged && ref === (o.payment_ref || null)) {
      toast('Nothing was different — no change recorded.'); close(); return;
    }
    toast(data.review === 'pending'
      ? 'Saved. Lexi will see it for approval.'
      : 'Saved.');
    close();
    await loadOrders();
  };

  return form;
}

// The history of an order, and Lexi's approve/undo where it applies.
function editTrail(o) {
  const wrap = document.createElement('div');
  const log = Array.isArray(o.edit_log) ? o.edit_log : [];
  if (!log.length) return wrap;

  const pending = log.filter(e => e.review === 'pending').length;
  wrap.className = 'edit-trail';
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'edit-trail-toggle' + (pending ? ' needs-review' : '');
  summary.textContent = pending
    ? `✎ Edited ${log.length}× · ${pending} waiting for Lexi`
    : `✎ Edited ${log.length}×`;
  wrap.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'edit-trail-list hidden';
  wrap.appendChild(list);
  summary.onclick = () => list.classList.toggle('hidden');

  log.slice().reverse().forEach((e, revIdx) => {
    const isLatest = revIdx === 0;
    const row = document.createElement('div');
    row.className = 'edit-entry';
    const changes = Object.entries(e.changes || {})
      .map(([f, [from, to]]) =>
        `<li><b>${EDIT_FIELD_LABEL[f] || f}:</b> ${esc(editValueText(f, from))} → ${esc(editValueText(f, to))}</li>`)
      .join('');
    const stateLabel = e.review === 'approved'
      ? `<span class="edit-state ok">Approved${e.reviewed_by ? ' by ' + esc(e.reviewed_by) : ''}</span>`
      : e.review === 'vetoed'
        ? `<span class="edit-state vetoed">Undone${e.reviewed_by ? ' by ' + esc(e.reviewed_by) : ''}</span>`
        : '<span class="edit-state pending">Waiting for Lexi</span>';
    row.innerHTML = `
      <div class="edit-entry-top"><b>${esc(e.by || 'Someone')}</b>
        <span>${esc((e.at || '').replace('T', ' ').slice(0, 16))}</span></div>
      <div class="edit-reason-text">“${esc(e.reason || '')}”</div>
      <ul class="edit-changes">${changes}</ul>
      ${stateLabel}`;

    // Only the prime admin reviews, and only the most recent edit can be
    // undone — restoring an older snapshot would silently throw away every
    // edit made after it.
    if (currentIsPrime && e.review === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'edit-review-actions';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'btn-secondary';
      approve.textContent = '✓ Approve';
      approve.onclick = () => reviewEdit(o.id, e.id, true);
      actions.appendChild(approve);
      if (isLatest) {
        const veto = document.createElement('button');
        veto.type = 'button';
        veto.className = 'btn-secondary danger-btn';
        veto.textContent = '✕ Undo this change';
        veto.onclick = () => {
          if (confirm('Put this order back the way it was before this edit?')) reviewEdit(o.id, e.id, false);
        };
        actions.appendChild(veto);
      }
      row.appendChild(actions);
    }
    list.appendChild(row);
  });
  return wrap;
}

async function reviewEdit(orderId, editId, approve) {
  const { error } = await db.rpc('review_order_edit', {
    p_order_id: orderId, p_edit_id: editId, p_approve: approve,
  });
  if (error) {
    console.error(error);
    toast(error.message?.includes('most recent')
      ? 'Undo the newest change first.'
      : 'Could not do that — try again.');
    return;
  }
  toast(approve ? 'Approved.' : 'Change undone.');
  await loadOrders();
}

function paymentRefField(o) {
  const wrap = document.createElement('label');
  wrap.className = 'ref-field';
  wrap.innerHTML = `<span class="field-label">Maya reference number</span>
    <input type="text" maxlength="60" autocomplete="off"
           placeholder="Type it in after the swipe" value="${esc(o.payment_ref || '')}">`;
  const input = wrap.querySelector('input');

  input.onchange = async () => {              // change = on blur, not per keystroke
    const ref = input.value.trim() || null;
    if (ref === (o.payment_ref || null)) return;
    input.disabled = true;
    // .select() because an RLS-blocked update returns success with zero rows —
    // without it the field would look saved while the order stayed unpaid.
    const { data, error } = await db.from('orders')
      .update({ payment_ref: ref }).eq('id', o.id).select('id');
    input.disabled = false;
    if (error || !data?.length) {
      console.error('payment_ref update failed', error);
      input.value = o.payment_ref || '';
      toast('Could not save that reference — try again.');
      return;
    }
    o.payment_ref = ref;
    Object.assign(state.orders.get(o.id) || {}, { payment_ref: ref });
    toast(ref ? 'Payment reference saved.' : 'Payment reference cleared.');
    renderOrders();                            // flips the chip to "paid"
  };
  return wrap;
}

function backBtn(label, fn) {
  const b = document.createElement('button');
  b.className = 'link-btn step-back';
  b.type = 'button';
  b.textContent = label;
  b.onclick = fn;
  return b;
}

async function setStatus(id, status) {
  const patch = { status };
  const o = state.orders.get(id);
  const goingBack = o && ORDER_RANK[status] < ORDER_RANK[o.status];
  // credit whoever carried it out; "Delivered ✓" is often tapped by the same
  // person moments later, so don't overwrite that with a later tapper
  if (status === 'on_the_way') patch.handled_by = currentName;
  if (status === 'cancelled') patch.cancelled_by = currentName;
  if (status === 'new') patch.cancelled_by = null; // uncancel wipes the blame
  // Stepping back has to undo what the forward tap stamped, or the record
  // keeps crediting someone for a delivery that didn't happen.
  if (goingBack && status === 'preparing') patch.handled_by = null;
  // Back in the unstarted queue means the escalation clock starts again —
  // otherwise a re-queued order can never nag anyone a second time.
  if (status === 'new') patch.escalated_at = null;
  const { error } = await db.from('orders').update(patch).eq('id', id);
  if (error) { toast('Update failed — try again.'); console.error(error); return; }
  if (o) { Object.assign(o, patch); renderOrders(); }
}

const ORDER_RANK = { cancelled: 0, new: 1, preparing: 2, on_the_way: 3, delivered: 4 };

// ── Senior/PWD discount (RA 9994 / RA 10754) ────────────────────────
// Tanawin is not VAT-registered, so the legal computation is simply 20%
// of the eligible diners' proportionate share — there is NO /1.12 VAT
// step here, and adding one would over-discount.

const hasDiscount = o => Number(o.discount_amount) > 0;

function computeDiscount(total, diners, eligible) {
  const perHead = Number(total) / diners;
  const share = perHead * eligible;
  const amount = Math.round(share * 0.2 * 100) / 100;
  return { perHead, share, amount, due: Number(total) - amount };
}

function discountForm(o, openBtn) {
  const wrap = document.createElement('div');
  wrap.className = 'discount-form';
  wrap.innerHTML = `
    <div class="discount-hint">Ask to see the Senior Citizen / PWD ID first. 20% off the eligible diners' share of the bill.</div>
    <div class="discount-inputs">
      <!-- start EMPTY: pre-filled 1s read as "already correct" and got applied
           unchanged, silently discounting a table of one -->
      <label>Diners <input type="number" class="disc-diners" min="1" step="1" inputmode="numeric"
             placeholder="0" value="${o.discount_diners ?? ''}"></label>
      <label>Senior/PWD <input type="number" class="disc-eligible" min="1" step="1" inputmode="numeric"
             placeholder="0" value="${o.discount_eligible ?? ''}"></label>
    </div>
    <div class="discount-preview"></div>
    <div class="order-actions">
      <button type="button" class="btn-primary disc-apply">Apply</button>
      ${hasDiscount(o) ? '<button type="button" class="btn-secondary disc-remove">Remove</button>' : ''}
      <button type="button" class="btn-secondary disc-close">Close</button>
    </div>`;

  const dinersEl = wrap.querySelector('.disc-diners');
  const eligibleEl = wrap.querySelector('.disc-eligible');
  const preview = wrap.querySelector('.discount-preview');
  const applyBtn = wrap.querySelector('.disc-apply');

  const refresh = () => {
    const diners = parseInt(dinersEl.value, 10);
    const eligible = parseInt(eligibleEl.value, 10);
    if (!(diners >= 1) || !(eligible >= 1) || eligible > diners) {
      preview.textContent = eligible > diners
        ? 'Senior/PWD count can’t exceed the number of diners.'
        : 'Enter how many diners and how many are senior/PWD.';
      applyBtn.disabled = true;
      return null;
    }
    const c = computeDiscount(o.total, diners, eligible);
    preview.innerHTML = `
      <div><span>Per head (${peso(o.total)} ÷ ${diners})</span><span>${peso(c.perHead.toFixed(2))}</span></div>
      <div><span>Senior/PWD share (× ${eligible})</span><span>${peso(c.share.toFixed(2))}</span></div>
      <div><span>Discount (20%)</span><span>−${peso(c.amount)}</span></div>
      <div class="preview-due"><span>Amount due</span><span>${peso(c.due)}</span></div>`;
    applyBtn.disabled = false;
    return { diners, eligible, amount: c.amount };
  };
  dinersEl.oninput = eligibleEl.oninput = refresh;
  refresh();

  applyBtn.onclick = () => {
    const v = refresh();
    if (v) saveDiscount(o.id, { discount_diners: v.diners, discount_eligible: v.eligible, discount_amount: v.amount, discount_by: currentName });
  };
  const removeBtn = wrap.querySelector('.disc-remove');
  if (removeBtn) removeBtn.onclick = () => {
    if (confirm('Remove the Senior/PWD discount from this order?'))
      saveDiscount(o.id, { discount_diners: null, discount_eligible: null, discount_amount: null, discount_by: null });
  };
  wrap.querySelector('.disc-close').onclick = () => { wrap.remove(); openBtn.classList.remove('hidden'); };
  return wrap;
}

async function saveDiscount(id, patch) {
  const { error } = await db.from('orders').update(patch).eq('id', id);
  if (error) { toast('Could not save the discount — try again.'); console.error(error); return; }
  const o = state.orders.get(id);
  if (o) { Object.assign(o, patch); renderOrders(); }
  toast(patch.discount_amount ? `Discount applied: −${peso(patch.discount_amount)}` : 'Discount removed.');
}

// Lexi reads this spreadsheet — raw `on_the_way` with an underscore doesn't
// belong in it. ("Sent out by" rather than "Ready by" for the same reason:
// handled_by is stamped when the order LEAVES the kitchen, not when it's cooked.)
const STATUS_LABEL = {
  new: 'New',
  preparing: 'Being prepped',
  on_the_way: 'On the way',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

// ── Excel export ────────────────────────────────────────────────────
// SheetJS loads lazily from the CDN only when someone actually exports.

let xlsxReady = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  xlsxReady ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = () => { xlsxReady = null; reject(new Error('could not load sheet library')); };
    document.head.appendChild(s);
  });
  return xlsxReady;
}

$('exportToggle').onclick = () => {
  const panel = $('exportPanel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if (opening && !$('exportFrom').value) {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    // local-date string (toISOString would shift to UTC and land a day early)
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    $('exportFrom').value = iso(first);
    $('exportTo').value = iso(now);
  }
};

$('exportBtn').onclick = async () => {
  const from = $('exportFrom').value, to = $('exportTo').value;
  if (!from || !to) { toast('Pick both dates.'); return; }
  const btn = $('exportBtn');
  btn.disabled = true;
  try {
    await loadXlsx();
    // 'to' is inclusive: query < the following midnight (local time)
    const end = new Date(to + 'T00:00:00');
    end.setDate(end.getDate() + 1);
    const { data, error } = await db.from('orders')
      .select('*, order_items(item_name, qty, unit_price, line_total)')
      .gte('created_at', new Date(from + 'T00:00:00').toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at');
    if (error) throw error;
    if (!data.length) { toast('No orders in that date range.'); return; }

    const dt = iso => { const d = new Date(iso); return {
      date: d.toLocaleDateString('en-PH'), time: d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }) }; };
    const ordersSheet = data.map(o => { const { date, time } = dt(o.created_at); return {
      'Order #': Number(o.order_number), 'Date': date, 'Time': time,
      'Room': o.is_dining_in ? 'Dining in' : (o.room_number || ''),
      // Which room's code authorised it — the only trace a dining-in order
      // leaves of who the guest actually was.
      'Booked under': o.access_room || '',
      'Guest name': o.guest_name || '', 'Table': o.table_label || '',
      'Status': STATUS_LABEL[o.status] || o.status, 'Payment': o.payment_intent,
      'Total (PHP)': Number(o.total),
      'Diners': o.discount_diners ?? '', 'Senior/PWD': o.discount_eligible ?? '',
      'Senior/PWD discount (PHP)': Number(o.discount_amount) || 0,
      'Amount due (PHP)': Number(o.total) - (Number(o.discount_amount) || 0),
      'Items': (o.order_items || []).map(i => `${i.item_name} x${i.qty}`).join('; '),
      'Note': o.note || '', 'Sent out by': o.handled_by || '', 'Cancelled by': o.cancelled_by || '',
      'Discount by': o.discount_by || '',
      // Clock times for reading a single day, minutes for charting a month.
      'Started at': o.acknowledged_at ? dt(o.acknowledged_at).time : '',
      'On the way at': o.on_the_way_at ? dt(o.on_the_way_at).time : '',
      'Delivered at': o.delivered_at ? dt(o.delivered_at).time : '',
      // Blank on paper orders for the same reason the card hides them: the
      // elapsed figure would measure bookkeeping, not service.
      'Mins to start': !o.is_manual && o.acknowledged_at ? minsAfterOrder(o, o.acknowledged_at) : '',
      'Mins to deliver': !o.is_manual && o.delivered_at ? minsAfterOrder(o, o.delivered_at) : '',
      'Taken on paper': o.is_manual ? 'Yes' : '',
      'Entered by': o.entered_by || '', 'Signed by': o.guest_signed_name || '',
      'Payment reference': o.payment_ref || '',
    }; });
    const linesSheet = data.flatMap(o => (o.order_items || []).map(i => ({
      'Order #': Number(o.order_number), 'Date': dt(o.created_at).date,
      'Item': i.item_name, 'Qty': i.qty,
      'Unit (PHP)': Number(i.unit_price), 'Line total (PHP)': Number(i.line_total),
    })));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ordersSheet), 'Orders');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linesSheet), 'Line items');
    XLSX.writeFile(wb, `tanawin-orders_${from}_to_${to}.xlsx`);
    toast(`Exported ${data.length} orders.`);
  } catch (err) {
    console.error(err);
    toast('Export failed — check your connection and try again.');
  } finally {
    btn.disabled = false;
  }
};

// ── Menu management ─────────────────────────────────────────────────

async function loadMenu() {
  const [menuRes, catRes] = await Promise.all([
    db.from('menu_items').select('*').order('sort_order').order('name'),
    db.from('categories').select('name, sort_order').order('sort_order'),
  ]);
  if (menuRes.error) { toast('Could not load menu.'); console.error(menuRes.error); return; }
  if (!catRes.error && catRes.data?.length) state.categories = catRes.data.map(c => c.name);
  state.menu = menuRes.data;
  renderCategorySelect();
  renderMenuList();
}

function renderCategorySelect(selected) {
  $('itemCategory').innerHTML =
    state.categories.map(c => `<option>${esc(c)}</option>`).join('') +
    '<option value="__new__">+ New category…</option>';
  if (selected) $('itemCategory').value = selected;
}

// Adding a category mid-edit: prompt, insert, keep it selected.
$('itemCategory').addEventListener('change', async () => {
  if ($('itemCategory').value !== '__new__') return;
  const name = (prompt('Name the new category (e.g. Burgers):') || '').trim();
  if (!name) { renderCategorySelect(state.categories[0]); return; }
  if (!state.categories.includes(name)) {
    const { error } = await db.from('categories')
      .insert({ name, sort_order: state.categories.length + 1 });
    if (error) { toast('Could not add category.'); console.error(error); renderCategorySelect(state.categories[0]); return; }
    state.categories.push(name);
    toast(`Category "${name}" added.`);
  }
  renderCategorySelect(name);
});

function renderMenuList() {
  const wrap = $('menuList');
  wrap.innerHTML = '';
  state.categories.forEach(cat => {
    const items = state.menu.filter(m => m.category === cat);
    if (!items.length) return;
    const label = document.createElement('div');
    label.className = 'menu-cat-label';
    label.textContent = cat;
    wrap.appendChild(label);
    items.forEach((m, idx) => wrap.appendChild(menuRow(m, items, idx)));
  });
}

function menuRow(m, catItems, idx) {
  const row = document.createElement('div');
  row.className = `menu-row${m.is_available ? '' : ' unavailable'}`;
  row.innerHTML = `
    ${m.image_url ? `<img src="${m.image_url}" alt="">` : `<div class="item-placeholder">${FLOWER_SVG}</div>`}
    <div class="menu-row-info">
      <strong>${esc(m.name)}</strong>
      <small>${peso(m.price)}${normalizeOptions(m).length ? ' · ' + esc(normalizeOptions(m).map(o => o.label).join(' / ')) : ''}${m.is_available ? '' : ' · hidden from guests'}</small>
    </div>
    <div class="menu-row-actions">
      <button class="icon-btn" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" title="Move down" ${idx === catItems.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn edit-btn" title="Edit item">✎<span>Edit</span></button>
      <input type="checkbox" class="avail-toggle" title="Available" ${m.is_available ? 'checked' : ''}>
    </div>`;

  const [up, down, edit] = row.querySelectorAll('.icon-btn');
  up.onclick = () => swapOrder(m, catItems[idx - 1]);
  down.onclick = () => swapOrder(m, catItems[idx + 1]);
  edit.onclick = () => openItemSheet(m);
  row.querySelector('.avail-toggle').onchange = async e => {
    const { error } = await db.from('menu_items')
      .update({ is_available: e.target.checked }).eq('id', m.id);
    if (error) { toast('Update failed.'); e.target.checked = !e.target.checked; return; }
    m.is_available = e.target.checked;
    renderMenuList();
  };
  return row;
}

async function swapOrder(a, b) {
  if (!b) return;
  // ensure distinct sort keys even if both defaulted to 0
  const aOrd = a.sort_order, bOrd = b.sort_order;
  const [newA, newB] = aOrd === bOrd ? [bOrd, aOrd + 1] : [bOrd, aOrd];
  const [r1, r2] = await Promise.all([
    db.from('menu_items').update({ sort_order: newA }).eq('id', a.id),
    db.from('menu_items').update({ sort_order: newB }).eq('id', b.id),
  ]);
  if (r1.error || r2.error) { toast('Reorder failed.'); return; }
  a.sort_order = newA; b.sort_order = newB;
  state.menu.sort((x, y) => x.sort_order - y.sort_order || x.name.localeCompare(y.name));
  renderMenuList();
}

// ── Item edit sheet ─────────────────────────────────────────────────

$('addItemBtn').onclick = () => openItemSheet(null);

function openItemSheet(m) {
  state.editingId = m ? m.id : null;
  state.pendingPhoto = null;
  state.photoRemoved = false;
  $('itemSheetTitle').textContent = m ? 'Edit item' : 'New item';
  $('itemName').value = m ? m.name : '';
  renderCategorySelect(m ? m.category : state.categories[0]);
  $('itemDescription').value = m ? (m.description || '') : '';
  $('itemPrice').value = m ? m.price : '';
  $('itemOptions').value = normalizeOptions(m)
    .map(o => o.price != null ? `${o.label} = ${o.price}` : o.label).join(', ');
  $('itemAvailable').checked = m ? m.is_available : true;
  $('itemDeleteBtn').classList.toggle('hidden', !m);
  $('itemPhotoInput').value = '';
  renderPhotoBox(m ? m.image_url : null);
  $('itemBackdrop').classList.remove('hidden');
  $('itemSheet').classList.remove('hidden');
}

function closeItemSheet() {
  $('itemBackdrop').classList.add('hidden');
  $('itemSheet').classList.add('hidden');
}
$('itemBackdrop').onclick = closeItemSheet;
$('itemCancelBtn').onclick = closeItemSheet;

function renderPhotoBox(url) {
  $('itemPhotoBox').innerHTML = url ? `<img src="${url}" alt="">` : FLOWER_SVG;
  $('itemPhotoDelete').classList.toggle('hidden', !url && !state.pendingPhoto);
}

$('itemPhotoInput').onchange = () => {
  const f = $('itemPhotoInput').files[0];
  if (!f) return;
  state.pendingPhoto = f;
  state.photoRemoved = false;
  renderPhotoBox(URL.createObjectURL(f));
};

$('itemPhotoDelete').onclick = () => {
  state.pendingPhoto = null;
  state.photoRemoved = true;
  $('itemPhotoInput').value = '';
  renderPhotoBox(null);
};

$('itemForm').onsubmit = async e => {
  e.preventDefault();
  const btn = $('itemSaveBtn');
  btn.disabled = true;
  try {
    const existing = state.menu.find(x => x.id === state.editingId);
    // "for 2 = 479, for 6 = 1099" or just "Hot, Iced" (no price = base price)
    const opts = $('itemOptions').value.split(',').map(s => s.trim()).filter(Boolean)
      .map(s => {
        const m2 = s.match(/^(.*?)\s*=\s*([\d.]+)$/);
        return m2 ? { label: m2[1].trim(), price: Number(m2[2]) } : { label: s, price: null };
      });
    if ($('itemCategory').value === '__new__') { toast('Pick a category first.'); btn.disabled = false; return; }
    const fields = {
      name: $('itemName').value.trim(),
      category: $('itemCategory').value,
      description: $('itemDescription').value.trim() || null,
      price: Number($('itemPrice').value),
      is_available: $('itemAvailable').checked,
      options: opts.length ? opts : null,
    };

    let id = state.editingId;
    if (!id) {
      const maxOrd = Math.max(0, ...state.menu.filter(m => m.category === fields.category).map(m => m.sort_order));
      const { data, error } = await db.from('menu_items')
        .insert({ ...fields, sort_order: maxOrd + 1 }).select().single();
      if (error) throw error;
      id = data.id;
    } else {
      const { error } = await db.from('menu_items').update(fields).eq('id', id);
      if (error) throw error;
    }

    // photo: upload new / remove old
    if (state.pendingPhoto) {
      const ext = (state.pendingPhoto.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${id}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      const { error: upErr } = await db.storage.from('menu-images').upload(path, state.pendingPhoto);
      if (upErr) throw upErr;
      const url = `${SUPABASE_URL}/storage/v1/object/public/menu-images/${path}`;
      const { error } = await db.from('menu_items').update({ image_url: url }).eq('id', id);
      if (error) throw error;
      if (existing?.image_url) removeStoredPhoto(existing.image_url);
    } else if (state.photoRemoved && existing?.image_url) {
      const { error } = await db.from('menu_items').update({ image_url: null }).eq('id', id);
      if (error) throw error;
      removeStoredPhoto(existing.image_url);
    }

    closeItemSheet();
    toast('Saved.');
    await loadMenu();
  } catch (err) {
    console.error(err);
    toast('Save failed — check the fields and try again.');
  } finally {
    btn.disabled = false;
  }
};

$('itemDeleteBtn').onclick = async () => {
  const existing = state.menu.find(x => x.id === state.editingId);
  if (!existing || !confirm(`Delete "${existing.name}" from the menu? Past orders keep their records.`)) return;
  const { error } = await db.from('menu_items').delete().eq('id', existing.id);
  if (error) { toast('Delete failed.'); console.error(error); return; }
  if (existing.image_url) removeStoredPhoto(existing.image_url);
  closeItemSheet();
  toast('Item deleted.');
  await loadMenu();
};

function removeStoredPhoto(url) {
  const marker = '/menu-images/';
  const i = url.indexOf(marker);
  if (i === -1) return; // not one of ours
  const path = url.slice(i + marker.length);
  if (path === 'gcash-qr.jpg') return; // never touch the payment QR
  db.storage.from('menu-images').remove([path]).catch(console.error);
}

// ── Paper orders ────────────────────────────────────────────────────
// An order taken by hand, keyed in afterwards. Staff tap the real menu so the
// total is computed server-side exactly like a guest order — nobody types an
// amount. The photo of the slip is kept as the source document, not as the
// data: a picture of a page can't be summed, discounted or exported.

// Orders this device just recorded, so the realtime feed doesn't chime at the
// person who typed them. See the INSERT handler for why it isn't name-matched.
const myManualOrders = new Set();
let lastManualSaveAt = 0;

$('paperToggle').onclick = () => {
  const panel = $('paperPanel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  $('exportPanel').classList.add('hidden');   // one panel at a time
  if (!opening) return;
  fillPaperRooms();
  // Back-dating moves an order into a period Lexi may already have
  // reconciled, so it stays with the people who own the books.
  $('paperWhenField').classList.toggle('hidden', currentRole !== 'admin');
  panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
};

function fillPaperRooms() {
  const sel = $('paperRoom');
  if (sel.options.length) return;
  (state.rooms || []).filter(r => r.kind === 'room' && r.is_active).forEach(r => {
    const o = document.createElement('option');
    o.value = r.name; o.textContent = r.name;
    sel.appendChild(o);
  });
}

$('paperLoc').addEventListener('change', () => {
  const room = document.querySelector('input[name="ploc"]:checked')?.value === 'room';
  $('paperRoomField').classList.toggle('hidden', !room);
});

$('paperPay').addEventListener('change', () => {
  const charging = document.querySelector('input[name="ppay"]:checked')?.value === 'room';
  $('paperSignBlock').classList.toggle('hidden', !charging);
  if (charging) paperSigInit();   // canvas only has layout once it's visible
});

// ── item picker ──
// Shared by the paper-order form and the edit form. Both need exactly the
// same thing — search the live menu, tap to add, adjust quantities, watch a
// running total — and two copies of that would drift apart the first time
// either changed.
//
// `lines` seeds it: empty for a new paper order, the current contents for an
// edit. Returns the element plus the accessors the caller needs; the caller
// never touches the internal map.
function itemPicker(lines = []) {
  const cart = new Map(lines.map(l => [`${l.id}|${l.option || ''}`, { ...l }]));

  const el = document.createElement('div');
  el.className = 'item-picker';
  el.innerHTML = `
    <input type="text" class="paper-search" placeholder="Search the menu…" autocomplete="off">
    <div class="paper-results"></div>
    <div class="paper-cart"></div>
    <div class="order-total-row"><span>Total</span><span class="picker-total">₱0</span></div>`;

  const search = el.querySelector('.paper-search');
  const results = el.querySelector('.paper-results');
  const cartBox = el.querySelector('.paper-cart');

  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    results.innerHTML = '';
    if (!q) return;
    // One row per orderable thing: an item with size options is really several
    // different prices, and staff are reading a slip that says "Pancit for 6".
    const rows = [];
    state.menu.filter(m => m.name.toLowerCase().includes(q)).forEach(m => {
      const opts = Array.isArray(m.options) ? m.options : [];
      if (!opts.length) { rows.push({ id: m.id, name: m.name, option: null, price: Number(m.price) }); return; }
      opts.forEach(o => {
        const label = typeof o === 'string' ? o : o.label;
        const price = typeof o === 'string' ? Number(m.price) : Number(o.price ?? m.price);
        rows.push({ id: m.id, name: m.name, option: label, price });
      });
    });
    rows.slice(0, 10).forEach(r => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'paper-result';
      b.innerHTML = `<span>${esc(r.name)}${r.option ? ` <small>${esc(r.option)}</small>` : ''}</span><span>${peso(r.price)}</span>`;
      b.onclick = () => {
        const key = `${r.id}|${r.option || ''}`;
        const line = cart.get(key);
        if (line) line.qty += 1; else cart.set(key, { ...r, qty: 1 });
        search.value = '';
        results.innerHTML = '';
        render();
      };
      results.appendChild(b);
    });
  };

  function render() {
    cartBox.innerHTML = '';
    let total = 0;
    cart.forEach((l, key) => {
      total += l.price * l.qty;
      const row = document.createElement('div');
      row.className = 'paper-line';
      row.innerHTML = `
        <span class="paper-line-name">${esc(l.name)}${l.option ? ` <small>${esc(l.option)}</small>` : ''}</span>
        <span class="paper-qty">
          <button type="button" class="icon-btn" data-d="-1">−</button>
          <b>${l.qty}</b>
          <button type="button" class="icon-btn" data-d="1">+</button>
        </span>
        <span class="paper-line-total">${peso(l.price * l.qty)}</span>`;
      row.querySelectorAll('[data-d]').forEach(btn => {
        btn.onclick = () => {
          l.qty += Number(btn.dataset.d);
          if (l.qty < 1) cart.delete(key);
          render();
        };
      });
      cartBox.appendChild(row);
    });
    el.querySelector('.picker-total').textContent = peso(total);
  }
  render();

  return {
    el,
    size: () => cart.size,
    clear: () => { cart.clear(); search.value = ''; results.innerHTML = ''; render(); },
    items: () => [...cart.values()].map(l => ({ menu_item_id: l.id, qty: l.qty, option: l.option })),
  };
}

// The paper form's picker, mounted where the static markup used to be.
const paperPicker = itemPicker();
$('paperPickerMount').appendChild(paperPicker.el);

// ── signature pad (charge to room only) ──
// Same pad the guest app uses, on the staff device: staff hand the phone over
// the way you'd hand over a card machine.
let paperSigCtx = null, paperSigInk = false;
const paperSig = $('paperSigCanvas');

function paperSigInit() {
  const rect = paperSig.getBoundingClientRect();
  if (!rect.width || paperSigCtx) return;
  const dpr = window.devicePixelRatio || 1;
  paperSig.width = rect.width * dpr;
  paperSig.height = rect.height * dpr;
  paperSigCtx = paperSig.getContext('2d');
  paperSigCtx.scale(dpr, dpr);
  paperSigCtx.lineWidth = 2.2;
  paperSigCtx.lineCap = 'round';
  paperSigCtx.lineJoin = 'round';
  paperSigCtx.strokeStyle = '#3D2317';
}
const paperSigPoint = e => {
  const r = paperSig.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
paperSig.addEventListener('pointerdown', e => {
  paperSigInit();
  if (!paperSigCtx) return;
  paperSig.setPointerCapture(e.pointerId);
  paperSigCtx.beginPath();
  paperSigCtx.moveTo(...paperSigPoint(e));
  e.preventDefault();
});
paperSig.addEventListener('pointermove', e => {
  if (!paperSigCtx || e.buttons !== 1) return;
  paperSigCtx.lineTo(...paperSigPoint(e));
  paperSigCtx.stroke();
  paperSigInk = true;
  e.preventDefault();
});
function paperSigClear() {
  if (paperSigCtx) paperSigCtx.clearRect(0, 0, paperSig.width, paperSig.height);
  paperSigInk = false;
}
$('paperSigClear').onclick = paperSigClear;

$('paperPhoto').onchange = () => {
  const f = $('paperPhoto').files[0];
  $('paperPhotoText').textContent = f ? `📷 ${f.name}` : '📷 Photo of the paper slip (optional)';
};

// ── save ──
$('paperSaveBtn').onclick = async () => {
  const btn = $('paperSaveBtn');
  if (!paperPicker.size()) { toast('Add at least one item first.'); return; }

  const diningIn = document.querySelector('input[name="ploc"]:checked')?.value !== 'room';
  const pay = document.querySelector('input[name="ppay"]:checked')?.value || 'cash';
  const signedName = $('paperSignedName').value.trim();
  if (pay === 'room' && (!paperSigInk || !signedName)) {
    toast('Charging to a room needs a signature and the signer’s name.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    let signatureUrl = null, paperUrl = null;
    if (pay === 'room') {
      const blob = await new Promise(r => paperSig.toBlob(r, 'image/png'));
      signatureUrl = `${crypto.randomUUID()}.png`;
      const { error } = await db.storage.from('signatures')
        .upload(signatureUrl, blob, { contentType: 'image/png' });
      if (error) throw error;
    }
    const photo = $('paperPhoto').files[0];
    if (photo) {
      paperUrl = `${crypto.randomUUID()}-${photo.name.replace(/[^\w.-]/g, '_')}`;
      const { error } = await db.storage.from('paper-orders')
        .upload(paperUrl, photo, { contentType: photo.type || 'image/jpeg' });
      if (error) throw error;
    }

    const when = $('paperWhen').value;
    lastManualSaveAt = Date.now();   // before the call: realtime can beat the reply
    const { data, error } = await db.rpc('place_manual_order', {
      p_room_name: diningIn ? null : $('paperRoom').value,
      p_is_dining_in: diningIn,
      p_payment_intent: pay,
      p_note: $('paperNote').value.trim() || null,
      p_items: paperPicker.items(),
      p_guest_name: $('paperGuestName').value.trim() || null,
      p_table_label: $('paperTable').value.trim() || null,
      p_signature_url: signatureUrl,
      p_guest_signed_name: signedName || null,
      p_paper_url: paperUrl,
      p_already_served: document.querySelector('input[name="served"]:checked')?.value === 'yes',
      // datetime-local has no timezone; the browser is already on Manila time
      p_ordered_at: when ? new Date(when).toISOString() : null,
    });
    if (error) throw error;

    myManualOrders.add(data.order_id);
    toast(`Recorded as order #${data.order_number}.`);
    resetPaperForm();
    $('paperPanel').classList.add('hidden');
    loadOrders();
  } catch (err) {
    console.error(err);
    toast(err.message === 'not authorised'
      ? 'Your login is no longer active — sign out and back in.'
      : 'Could not save that order. Check your connection and try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Record this order';
  }
};

function resetPaperForm() {
  paperPicker.clear();
  paperSigClear();
  ['paperGuestName', 'paperTable', 'paperNote', 'paperSignedName', 'paperWhen']
    .forEach(id => { $(id).value = ''; });
  $('paperPhoto').value = '';
  $('paperPhotoText').textContent = '📷 Photo of the paper slip (optional)';
  $('paperResults').innerHTML = '';
  document.querySelector('input[name="served"][value="no"]').checked = true;
  document.querySelector('input[name="ploc"][value="dining"]').checked = true;
  document.querySelector('input[name="ppay"][value="cash"]').checked = true;
  $('paperRoomField').classList.add('hidden');
  $('paperSignBlock').classList.add('hidden');
}

// ── Rooms: access codes ─────────────────────────────────────────────

async function loadRooms() {
  const { data, error } = await db.from('rooms')
    .select('name, code, kind, is_active').order('created_at');
  if (error) { console.error(error); return; }
  state.rooms = data;
  const wrap = $('roomsList');
  wrap.innerHTML = '';
  data.forEach(room => wrap.appendChild(roomRow(room)));
}

function roomRow(room) {
  const row = document.createElement('div');
  row.className = `room-row${room.is_active ? '' : ' unavailable'}`;
  row.innerHTML = `
    <div class="menu-row-info">
      <strong>${esc(room.name)}${room.kind === 'dining' ? ' 🍽' : ''}</strong>
      <small>${room.is_active ? 'active' : 'DISABLED — code won’t work'}</small>
    </div>
    <span class="room-code">${esc(room.code)}</span>
    <div class="menu-row-actions">
      <button class="icon-btn rotate-btn" title="Replace this code">New<br>code</button>
      <input type="checkbox" class="avail-toggle" title="Active" ${room.is_active ? 'checked' : ''}>
    </div>`;

  row.querySelector('.rotate-btn').onclick = async () => {
    if (!confirm(`Replace the code for ${room.name}? The old code stops working immediately.`)) return;
    // retry a couple of times on the (unlikely) chance of a duplicate code
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = String(Math.floor(100000 + Math.random() * 900000));
      const { error } = await db.from('rooms').update({ code: fresh }).eq('name', room.name);
      if (!error) { toast(`${room.name}: new code ${fresh}`); return loadRooms(); }
      if (!String(error.message).includes('duplicate')) {
        toast('Could not replace the code.'); console.error(error); return;
      }
    }
    toast('Could not replace the code — try again.');
  };

  row.querySelector('.avail-toggle').onchange = async e => {
    const { error } = await db.from('rooms')
      .update({ is_active: e.target.checked }).eq('name', room.name);
    if (error) { toast('Update failed.'); e.target.checked = !e.target.checked; return; }
    loadRooms();
  };
  return row;
}

// ── Staff management (admin only) ───────────────────────────────────

async function loadStaff() {
  const { data, error } = await db.from('staff')
    .select('slug, name, role, is_active, is_prime, auth_uid').order('sort_order');
  if (error) { console.error(error); return; }
  const wrap = $('staffList');
  wrap.innerHTML = '';
  data.forEach(s => wrap.appendChild(staffRow(s)));
}

function staffRow(s) {
  const isSelf = s.auth_uid === currentAuthId;
  const targetIsAdminish = s.is_prime || s.role === 'admin';
  const canRemove = !s.is_prime && !isSelf && (s.role !== 'admin' || currentIsPrime);
  const canToggleRole = currentIsPrime && !s.is_prime && !isSelf;
  const canSetPin = isSelf || (targetIsAdminish ? currentIsPrime : true);

  const roleLabel = s.is_prime ? 'Owner — full access, protected'
    : s.role === 'admin' ? 'Admin — full access' : 'Staff';

  const row = document.createElement('div');
  row.className = 'staff-row';
  row.innerHTML = `
    <span class="avatar ${s.role}">${esc(s.name[0] || '?')}</span>
    <div class="menu-row-info">
      <strong>${esc(s.name)}${s.is_prime ? ' 👑' : ''}</strong>
      <small>${roleLabel}</small>
    </div>
    <div class="menu-row-actions">
      ${canToggleRole ? `<button class="icon-btn text-btn role-btn">${s.role === 'admin' ? 'Revoke admin' : 'Make admin'}</button>` : ''}
      ${canSetPin ? `<button class="icon-btn text-btn pin-btn" title="Change PIN">New PIN</button>` : ''}
      ${canRemove ? `<button class="icon-btn remove-btn" title="Remove">✕</button>` : ''}
    </div>`;

  row.querySelector('.pin-btn')?.addEventListener('click', async () => {
    const pin = prompt(`New 4-digit PIN for ${s.name}:`);
    if (pin == null) return;
    if (!/^\d{4}$/.test(pin.trim())) { toast('PIN must be exactly 4 digits.'); return; }
    const { error } = await callManageStaff({ action: 'set_pin', slug: s.slug, pin: pin.trim() });
    toast(error || `${s.name}'s PIN updated.`);
  });

  row.querySelector('.role-btn')?.addEventListener('click', async () => {
    const makeAdmin = s.role !== 'admin';
    const verb = makeAdmin ? 'Give admin access to' : 'Revoke admin access from';
    if (!confirm(`${verb} ${s.name}?`)) return;
    const { error } = await callManageStaff({ action: 'set_role', slug: s.slug, role: makeAdmin ? 'admin' : 'staff' });
    if (error) { toast(error); return; }
    toast(`${s.name} is now ${makeAdmin ? 'an admin' : 'staff'}.`);
    loadStaff();
  });

  row.querySelector('.remove-btn')?.addEventListener('click', async () => {
    if (!confirm(`Remove ${s.name}? Their login stops working immediately.`)) return;
    const { error } = await callManageStaff({ action: 'remove', slug: s.slug });
    if (error) { toast(error); return; }
    toast(`${s.name} removed.`);
    loadStaff();
  });
  return row;
}

// Calls the admin-gated Edge Function; returns { error } (string) on failure.
async function callManageStaff(body) {
  const { data, error } = await db.functions.invoke('manage-staff', { body });
  if (error) {
    // the function returns a JSON { error } with a friendly message
    let msg = 'Something went wrong.';
    try { msg = (await error.context.json()).error || msg; } catch { /* keep default */ }
    return { error: msg };
  }
  if (data?.error) return { error: data.error };
  return { data };
}

$('addStaffBtn').onclick = async () => {
  const name = $('newStaffName').value.trim();
  const role = $('newStaffRole').value;
  const pin = $('newStaffPin').value.trim();
  if (!name) { toast('Enter a name.'); return; }
  if (!/^\d{4}$/.test(pin)) { toast('PIN must be exactly 4 digits.'); return; }
  const btn = $('addStaffBtn');
  btn.disabled = true;
  const { data, error } = await callManageStaff({ action: 'add', name, role, pin });
  btn.disabled = false;
  if (error) { toast(error); return; }
  $('newStaffName').value = ''; $('newStaffPin').value = ''; $('newStaffRole').value = 'staff';
  toast(`${data.name} added — they can log in with their PIN.`);
  loadStaff();
};

// ── Settings ────────────────────────────────────────────────────────

async function loadSettings() {
  const { data, error } = await db.from('settings').select('key, value');
  if (error) { console.error(error); return; }
  const map = Object.fromEntries(data.map(r => [r.key, r.value]));
  $('smsNumbers').value = map.staff_sms_numbers || '';
  $('smsEnabled').checked = map.sms_enabled === 'true';
  $('qrTextAbove').value = map.qr_text_above || '';
  $('qrTextBelow').value = map.qr_text_below || '';
  $('settingsQr').src = `${GCASH_QR_URL}?t=${Date.now()}`;
}

$('saveQrTextBtn').onclick = async () => {
  const updates = [
    { key: 'qr_text_above', value: $('qrTextAbove').value.trim() },
    { key: 'qr_text_below', value: $('qrTextBelow').value.trim() },
  ].map(r => ({ ...r, updated_at: new Date().toISOString() }));
  const { error } = await db.from('settings').upsert(updates);
  if (error) { toast('Save failed.'); console.error(error); return; }
  toast('Poster text saved — reopen the poster to see it.');
};

// These save on change rather than behind a Save button. A switch that looks
// flipped but hasn't been written is worse than no switch at all — you only
// find out the next time an alert doesn't arrive.
async function saveSetting(key, value) {
  const { error } = await db.from('settings')
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) console.error(error);
  return !error;
}

$('smsEnabled').onchange = async e => {
  const on = e.target.checked;
  e.target.disabled = true;
  const ok = await saveSetting('sms_enabled', String(on));
  e.target.disabled = false;
  // Snap back on failure, so the switch never shows a state the DB doesn't hold.
  if (!ok) { e.target.checked = !on; toast("Couldn't save that — check your connection."); return; }
  toast(on ? 'SMS notifications on.' : 'SMS notifications off.');
};

// `change` on a text input fires on blur, not per keystroke — one write when
// they're done typing.
$('smsNumbers').onchange = async e => {
  const ok = await saveSetting('staff_sms_numbers', e.target.value.trim());
  toast(ok ? 'SMS numbers saved.' : "Couldn't save that — check your connection.");
};

// Enter in the numbers field would otherwise submit and reload the page.
$('settingsForm').onsubmit = e => e.preventDefault();

$('qrUpload').onchange = async () => {
  const f = $('qrUpload').files[0];
  if (!f) return;
  const { error } = await db.storage.from('menu-images')
    .upload('gcash-qr.jpg', f, { upsert: true, contentType: f.type || 'image/jpeg' });
  if (error) { toast('QR upload failed.'); console.error(error); return; }
  $('settingsQr').src = `${GCASH_QR_URL}?t=${Date.now()}`;
  toast('Payment QR replaced.');
};

// ── Order alerts ────────────────────────────────────────────────────
// The dashboard has to be open for any of this to fire — there's no push
// subscription. What this adds on top of the toast: a system notification
// while the tab is backgrounded, an optional screen wake-lock for the
// front-desk duty device, and a chime that keeps nagging until someone
// actually starts prepping.

const NAG_EVERY_MS = 20000;
const NAG_MAX = 15;            // ~5 min, then it gives up (nobody's there)
const WAKE_PREF = 'tanawin-keep-awake';
const BASE_TITLE = document.title;

let swReg = null;
let nagTimer = null;
let nagsLeft = 0;
let wakeSentinel = null;

async function initAlerts() {
  // Android Chrome only allows notifications via a service-worker registration
  // (`new Notification()` throws there), so register before we need one.
  if ('serviceWorker' in navigator) {
    try {
      swReg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
    } catch { /* desktop fallback below */ }
  }
  await refreshPushState();
  renderAlertChips();
  if (localStorage.getItem(WAKE_PREF) === '1') acquireWake();
}

const canNotify = () => 'Notification' in window || !!swReg;

function renderAlertChips() {
  const n = $('notifyChip');
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  n.classList.toggle('on', perm === 'granted');
  n.classList.toggle('muted', perm === 'denied' || perm === 'unsupported');
  n.textContent = perm === 'granted' ? '🔔 Alerts on'
    : perm === 'denied' ? '🔔 Alerts blocked'
      : perm === 'unsupported' ? '🔔 Alerts unavailable' : '🔔 Turn on alerts';
  n.title = perm === 'denied'
    ? 'Your browser is blocking notifications for this site — re-allow them in browser settings.'
    : perm === 'unsupported'
      ? 'This browser cannot show notifications. On iPhone, add the dashboard to your Home Screen first.'
      : 'Pop up an alert when an order arrives while this tab is in the background.';

  renderPushChip();

  const w = $('wakeChip');
  const on = localStorage.getItem(WAKE_PREF) === '1';
  w.classList.toggle('on', on);
  w.textContent = on ? '🔆 Screen stays on' : '🔆 Keep screen on';
  w.title = 'Stops this device from sleeping while the dashboard is open. Best for the front-desk phone or tablet.';
}

$('notifyChip').onclick = async () => {
  if (!('Notification' in window)) {
    toast('This browser cannot show alerts. On iPhone, add the dashboard to your Home Screen first.');
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Alerts are blocked in your browser settings — allow them there, then tap again.');
    return;
  }
  if (Notification.permission === 'granted') { showOrderNotification(null); return; } // re-tap = test alert
  const res = await Notification.requestPermission();
  renderAlertChips();
  if (res === 'granted') { primeChime(); chime(); showOrderNotification(null); toast('Alerts on.'); }
  else toast('Alerts not turned on.');
};

// ── Push: alerts with the app closed ────────────────────────────────
// Needs the dashboard INSTALLED (Home Screen / "Install app") on phones —
// iOS refuses notifications to a plain Safari tab, and Android only offers
// the install prompt for an installed-capable page. Delivery also needs a
// working data connection, which is exactly why SMS stays the fallback.

let pushSub = null;

const isInstalled = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const isApple = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);

const pushSupported = () =>
  !!swReg && 'PushManager' in window && 'Notification' in window;

async function refreshPushState() {
  pushSub = swReg ? await swReg.pushManager.getSubscription() : null;
  if (pushSub && !subscribedWithCurrentKey(pushSub)) await healStalePushSubscription();
}

// A subscription is bound to the VAPID key it was created with. If that key is
// ever replaced, the old subscription keeps LOOKING fine on the device but the
// push service rejects every send (403 — which isn't a 404/410, so the sender
// never prunes it either). Rather than making staff notice and re-enable it,
// swap it for a fresh one the next time they open the dashboard.
function subscribedWithCurrentKey(sub) {
  const stored = sub.options?.applicationServerKey;
  if (!stored) return true;                    // can't tell — leave it alone
  const a = new Uint8Array(stored);
  const b = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function healStalePushSubscription() {
  try {
    const dead = pushSub.endpoint;
    await pushSub.unsubscribe();
    pushSub = null;
    await db.from('push_subscriptions').delete().eq('endpoint', dead);
    if (Notification.permission !== 'granted') return;   // they'd have to re-allow
    const sub = await withTimeout(swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    }), 20000, 'subscribe');
    const json = sub.toJSON();
    const { error } = await db.from('push_subscriptions').upsert({
      endpoint: sub.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth,
      auth_uid: currentAuthId, staff_name: currentName,
    }, { onConflict: 'endpoint' });
    if (error) { await sub.unsubscribe(); throw error; }
    pushSub = sub;
    console.log('push subscription re-issued against the current VAPID key');
  } catch (err) {
    console.warn('could not re-issue push subscription', err);
  }
}

function renderPushChip() {
  const c = $('pushChip');
  const hint = $('installHint');
  hint.classList.add('hidden');

  if (!pushSupported()) {
    c.classList.remove('on');
    c.classList.add('muted');
    c.textContent = '📲 Alerts when closed';
    c.title = 'This browser cannot receive alerts while the app is closed.';
    // Staff are on Android, and the usual cause there is opening the link from
    // inside a chat app's built-in browser, which has no push support.
    hint.textContent = isApple()
      ? 'iPhone: tap Share → “Add to Home Screen”, open Tanawin Staff from there, then turn this on.'
      : 'Open this page in the Chrome app itself — alerts don’t work in the small browser that opens inside Messenger/Viber. Tap ⋮ → “Open in Chrome”.';
    hint.classList.remove('hidden');
    return;
  }
  c.classList.remove('muted');
  c.classList.toggle('on', !!pushSub);
  c.textContent = pushSub ? '📲 Alerts when closed: on' : '📲 Alerts when closed';
  c.title = pushSub
    ? 'This device gets order alerts even with the dashboard closed. Tap to turn off.'
    : 'Get order alerts on this device even when the dashboard is closed.';

  // On a phone browser (not installed) push often works on Android but never
  // on iOS — nudge toward installing either way, it's the reliable path.
  if (!pushSub && !isInstalled() && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    hint.textContent = isApple()
      ? 'iPhone: tap Share → “Add to Home Screen” first, then open Tanawin Staff from the Home Screen.'
      : 'Tip: Chrome menu ⋮ → “Install app” gives you a Tanawin icon. If alerts arrive late, also set Settings → Apps → Chrome → Battery → Unrestricted.';
    hint.classList.remove('hidden');
  }
}

// VAPID keys travel as base64url; PushManager wants raw bytes.
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

$('pushChip').onclick = async () => {
  if (!pushSupported()) {
    toast('This browser cannot alert you while the app is closed. On iPhone, add it to the Home Screen first.');
    return;
  }
  const btn = $('pushChip');
  btn.disabled = true;
  btn.textContent = '📲 Setting up…';   // a greyed chip with no explanation reads as broken
  try {
    if (pushSub) {                                   // turning it off
      await db.from('push_subscriptions').delete().eq('endpoint', pushSub.endpoint);
      await pushSub.unsubscribe();
      pushSub = null;
      toast('This device will no longer get alerts when closed.');
    } else {
      if (Notification.permission !== 'granted') {
        const res = await Notification.requestPermission();
        if (res !== 'granted') { toast('Alerts not turned on.'); return; }
      }
      // subscribe() talks to the push service, which can hang for minutes on a
      // bad connection — cap it so the chip never sits there greyed out.
      const sub = await withTimeout(swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      }), 20000, 'subscribe');
      const json = sub.toJSON();
      const { error } = await db.from('push_subscriptions').upsert({
        endpoint: sub.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        auth_uid: currentAuthId,
        staff_name: currentName,
      }, { onConflict: 'endpoint' });
      if (error) { await sub.unsubscribe(); throw error; }
      pushSub = sub;
      toast('Done — this device gets alerts even when closed.');
    }
  } catch (err) {
    console.error(err);
    toast(err?.message === 'subscribe timed out'
      ? 'Setting up alerts timed out — check the internet connection and try again.'
      : 'Could not change that — try again.');
  } finally {
    btn.disabled = false;
    renderAlertChips();      // rewrites the label, clearing "Setting up…"
  }
};

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]);
}

$('wakeChip').onclick = () => {
  const on = localStorage.getItem(WAKE_PREF) === '1';
  if (on) { localStorage.removeItem(WAKE_PREF); releaseWake(); }
  else { localStorage.setItem(WAKE_PREF, '1'); acquireWake(); }
  renderAlertChips();
};

// `o` null = the test alert fired by tapping the chip.
async function showOrderNotification(o) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = o ? `New order #${o.order_number}` : 'Tanawin alerts are on';
  const body = o
    ? `${o.is_dining_in ? 'Dining in' : 'Room ' + (o.room_number || '?')} · ${peso(o.total)}`
    : 'This is how a new order will look.';
  const opts = { body, icon: 'assets/icon-192.png', badge: 'assets/icon-192.png',
                 tag: o ? `order-${o.id}` : 'test', renotify: true };
  try {
    if (swReg?.showNotification) await swReg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch (err) { console.warn('notification failed', err); }
}

async function showRequestNotification(r) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const kind = REQUEST_KINDS[r.kind] || { label: 'Guest request', icon: '🛎' };
  const opts = { body: `${r.room_name || 'Guest'}${r.out_of_hours ? ' · overnight' : ''}`,
                 icon: 'assets/icon-192.png', badge: 'assets/icon-192.png',
                 tag: `request-${r.id}`, renotify: true };
  try {
    if (swReg?.showNotification) await swReg.showNotification(`${kind.icon} ${kind.label}`, opts);
    else new Notification(`${kind.icon} ${kind.label}`, opts);
  } catch (err) { console.warn('notification failed', err); }
}

async function acquireWake() {
  if (!('wakeLock' in navigator) || wakeSentinel || document.visibilityState !== 'visible') return;
  try {
    wakeSentinel = await navigator.wakeLock.request('screen');
    wakeSentinel.addEventListener('release', () => { wakeSentinel = null; });
  } catch { wakeSentinel = null; }
}

function releaseWake() { wakeSentinel?.release(); wakeSentinel = null; }

// The OS drops the wake lock whenever the tab is hidden — take it back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && localStorage.getItem(WAKE_PREF) === '1') acquireWake();
});

function startNagging() {
  stopNagging();
  nagsLeft = NAG_MAX;
  nagTimer = setInterval(() => {
    if (!waitingCount() || nagsLeft-- <= 0) { stopNagging(); return; }
    chime();
  }, NAG_EVERY_MS);
}

function stopNagging() { clearInterval(nagTimer); nagTimer = null; }

// unacknowledged work of either kind — what the nag and tab title count
const waitingCount = () =>
  [...state.orders.values()].filter(o => o.status === 'new').length +
  [...state.requests.values()].filter(r => r.status === 'new').length;

// Unacknowledged count rides in the tab title so a backgrounded dashboard
// still shows something.
function syncAlertState() {
  const waiting = waitingCount();
  document.title = waiting ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE;
  if (!waiting) stopNagging();
}

// ── Chime (no audio asset needed) ───────────────────────────────────

let audioCtx = null;
function primeChime() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
}
function chime() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [[880, 0], [1174.66, 0.18]].forEach(([freq, dt]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.001, now + dt);
    gain.gain.exponentialRampToValueAtTime(0.25, now + dt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dt + 0.5);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + dt);
    osc.stop(now + dt + 0.55);
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

function peso(n) {
  const v = Number(n);
  const opts = Number.isInteger(v) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `₱${v.toLocaleString('en-PH', opts)}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeLabel(iso) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d) / 60000);
  const clock = d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  if (mins < 1) return `just now · ${clock}`;
  if (mins < 60) return `${mins} min ago · ${clock}`;
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }) + ' · ' + clock;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

boot();
