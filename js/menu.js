// Tanawin Menu — guest surface logic.

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// The flower accent inline (uses currentColor, which <img> can't inherit).
const FLOWER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><g transform="translate(16 16)"><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(45)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(90)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(135)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(180)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(225)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(270)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(315)"/><circle r="2.9"/></g></svg>`;
document.querySelectorAll('[data-flower]').forEach(el => { el.innerHTML = FLOWER_SVG; });

const $ = id => document.getElementById(id);

const state = {
  items: new Map(),          // id -> menu item row
  cart: new Map(),           // "id|option" -> { id, option, qty }
  categories: CATEGORIES,    // replaced by the categories table on load
  diningIn: false,
  roomName: null,
  proofFile: null,
};

const cartKey = (id, option) => `${id}|${option || ''}`;

// Options may be plain strings ("Hot") or priced ({label:"for 2", price:479}).
function normalizeOptions(it) {
  if (!Array.isArray(it?.options)) return [];
  return it.options.map(o =>
    typeof o === 'string' ? { label: o, price: null } : { label: o.label, price: o.price ?? null });
}

function priceFor(it, optionLabel) {
  if (optionLabel) {
    const opt = normalizeOptions(it).find(o => o.label === optionLabel);
    if (opt && opt.price != null) return Number(opt.price);
  }
  return Number(it.price);
}

// Card price label: "from ₱400" when the options carry different prices.
function priceLabel(it) {
  const opts = normalizeOptions(it);
  const prices = opts.map(o => o.price != null ? Number(o.price) : Number(it.price));
  if (!prices.length) return peso(it.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  return max > min ? `from ${peso(min)}` : peso(min);
}

function itemQtyTotal(id) {
  let n = 0;
  for (const e of state.cart.values()) if (e.id === id) n += e.qty;
  return n;
}

// ── Load & render the menu ──────────────────────────────────────────

async function loadMenu() {
  const [menuRes, catRes] = await Promise.all([
    // Filter explicitly rather than leaning on RLS: anon only ever gets
    // available rows, but an authenticated staff session may read ALL of them,
    // which would leak hidden items into the guest page — and make the
    // "exactly what guests see" preview a lie.
    db.from('menu_items')
      .select('id, name, category, description, image_url, price, sort_order, options')
      .eq('is_available', true)
      .order('sort_order')
      .order('name'),
    db.from('categories').select('name, sort_order').order('sort_order'),
  ]);

  if (menuRes.error) {
    $('loading').innerHTML = '<p>Could not load the menu. Please check your connection and refresh.</p>';
    console.error(menuRes.error);
    return;
  }
  if (!catRes.error && catRes.data?.length) {
    state.categories = catRes.data.map(c => c.name);
  }

  menuRes.data.forEach(it => state.items.set(it.id, it));
  renderMenu(menuRes.data);
  restoreCart();
}

function renderMenu(items) {
  const byCat = new Map(state.categories.map(c => [c, []]));
  items.forEach(it => { if (byCat.has(it.category)) byCat.get(it.category).push(it); });

  const nav = $('catNav');
  const main = $('menu');
  main.innerHTML = '';
  nav.innerHTML = '';

  for (const [cat, catItems] of byCat) {
    if (!catItems.length) continue;

    const pill = document.createElement('button');
    pill.className = 'cat-pill';
    pill.textContent = cat;
    pill.onclick = () => {
      document.getElementById(`cat-${cat}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    nav.appendChild(pill);

    const section = document.createElement('section');
    section.className = 'cat-section';
    section.id = `cat-${cat}`;
    section.innerHTML = `<h2>${cat}</h2>`;
    catItems.forEach(it => section.appendChild(itemCard(it)));
    main.appendChild(section);
  }

  if (!main.children.length) {
    main.innerHTML = '<div class="loading"><p>The menu is being prepared — please check back soon.</p></div>';
  }
}

function itemCard(it) {
  const card = document.createElement('article');
  card.className = 'item-card';
  card.dataset.id = it.id;

  const photo = it.image_url
    ? `<img class="item-photo" src="${it.image_url}" alt="" loading="lazy">`
    : `<div class="item-placeholder">${FLOWER_SVG}</div>`;

  card.innerHTML = `
    ${photo}
    <div class="item-info">
      <h3>${esc(it.name)}</h3>
      ${it.description ? `<p>${esc(it.description)}</p>` : ''}
      <div class="item-price">${priceLabel(it)}</div>
    </div>
    <div class="item-actions"></div>`;

  renderItemActions(card, it.id);
  return card;
}

function renderItemActions(card, id) {
  const box = card.querySelector('.item-actions');
  const it = state.items.get(id);
  const hasOptions = Array.isArray(it?.options) && it.options.length > 0;

  if (hasOptions) {
    // Option items always go through the chooser; quantities are adjusted
    // per option line in the cart.
    const total = itemQtyTotal(id);
    box.innerHTML = `
      ${total ? `<span class="in-cart-pill">${total} in cart</span>` : ''}
      <button class="add-btn" aria-label="Choose and add">+</button>`;
    box.querySelector('.add-btn').onclick = () => openOptionPicker(it);
    return;
  }

  const qty = state.cart.get(cartKey(id, null))?.qty || 0;
  if (!qty) {
    box.innerHTML = `<button class="add-btn" aria-label="Add to order">+</button>`;
    box.querySelector('button').onclick = () => setQty(id, null, 1);
  } else {
    box.innerHTML = `
      <div class="qty-stepper">
        <button aria-label="Remove one">−</button><span>${qty}</span><button aria-label="Add one">+</button>
      </div>`;
    const [minus, plus] = box.querySelectorAll('button');
    minus.onclick = () => setQty(id, null, qty - 1);
    plus.onclick = () => setQty(id, null, qty + 1);
  }
}

// ── Option picker (e.g. Hot / Iced) ─────────────────────────────────

function openOptionPicker(it) {
  $('optTitle').textContent = it.name;
  const box = $('optButtons');
  box.innerHTML = '';
  normalizeOptions(it).forEach(opt => {
    const b = document.createElement('button');
    b.className = 'opt-btn';
    b.innerHTML = `${esc(opt.label)}<small>${peso(priceFor(it, opt.label))}</small>`;
    b.onclick = () => {
      const cur = state.cart.get(cartKey(it.id, opt.label))?.qty || 0;
      setQty(it.id, opt.label, cur + 1);
      closeOptionPicker();
    };
    box.appendChild(b);
  });
  $('optBackdrop').classList.remove('hidden');
  $('optSheet').classList.remove('hidden');
}

function closeOptionPicker() {
  $('optBackdrop').classList.add('hidden');
  $('optSheet').classList.add('hidden');
}
$('optBackdrop').onclick = closeOptionPicker;

// ── Cart ────────────────────────────────────────────────────────────

function setQty(id, option, qty) {
  const key = cartKey(id, option);
  if (qty <= 0) state.cart.delete(key);
  else state.cart.set(key, { id, option: option || null, qty: Math.min(qty, 50) });

  const card = document.querySelector(`.item-card[data-id="${id}"]`);
  if (card) renderItemActions(card, id);
  updateCartBar();
  if (!$('cartSheet').classList.contains('hidden')) {
    renderCartLines();
    if (cartTotals().count === 0) closeSheet();
  }
  saveCart();
}

function cartTotals() {
  let count = 0, total = 0;
  for (const e of state.cart.values()) {
    const it = state.items.get(e.id);
    if (!it) continue;
    count += e.qty;
    total += priceFor(it, e.option) * e.qty;
  }
  return { count, total };
}

function updateCartBar() {
  const { count, total } = cartTotals();
  $('cartBar').classList.toggle('hidden', count === 0);
  $('cartBarCount').textContent = count;
  $('cartBarTotal').textContent = peso(total);
  $('orderBanner').classList.toggle('raised', count > 0);
}

function renderCartLines() {
  const ul = $('cartLines');
  ul.innerHTML = '';
  for (const e of state.cart.values()) {
    const it = state.items.get(e.id);
    if (!it) continue;
    const unit = priceFor(it, e.option);
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="cart-line-name">${esc(it.name)}${e.option ? ` <em>· ${esc(e.option)}</em>` : ''}
        <small>${peso(unit)} each</small></div>
      <div class="qty-stepper">
        <button aria-label="Remove one">−</button><span>${e.qty}</span><button aria-label="Add one">+</button>
      </div>
      <strong>${peso(unit * e.qty)}</strong>`;
    const [minus, plus] = li.querySelectorAll('button');
    minus.onclick = () => setQty(e.id, e.option, e.qty - 1);
    plus.onclick = () => setQty(e.id, e.option, e.qty + 1);
    ul.appendChild(li);
  }
  $('cartTotal').textContent = peso(cartTotals().total);
}

function saveCart() {
  localStorage.setItem('tanawin-cart-v2', JSON.stringify([...state.cart.values()]));
}

function restoreCart() {
  localStorage.removeItem('tanawin-cart'); // pre-options format
  try {
    const saved = JSON.parse(localStorage.getItem('tanawin-cart-v2') || '[]');
    saved.forEach(e => {
      const it = state.items.get(e.id);
      if (!it) return;
      if (e.option && !normalizeOptions(it).some(o => o.label === e.option)) return;
      state.cart.set(cartKey(e.id, e.option), { id: e.id, option: e.option || null, qty: e.qty });
    });
  } catch { /* fresh start */ }
  for (const e of state.cart.values()) {
    const card = document.querySelector(`.item-card[data-id="${e.id}"]`);
    if (card) renderItemActions(card, e.id);
  }
  updateCartBar();
}

// ── Sheet navigation ────────────────────────────────────────────────

function openSheet(step) {
  $('sheetBackdrop').classList.remove('hidden');
  $('cartSheet').classList.remove('hidden');
  ['cartStep', 'checkoutStep', 'confirmStep'].forEach(s =>
    $(s).classList.toggle('hidden', s !== step));
  if (step === 'cartStep') renderCartLines();
  if (step === 'checkoutStep' && payIntent() === 'room') sigInit(); // canvas has layout now
}

function closeSheet() {
  $('sheetBackdrop').classList.add('hidden');
  $('cartSheet').classList.add('hidden');
  const t = trackedOrder();
  if (t) renderTracker(t.status); // sheet closed → surface the banner
}

$('cartBar').onclick = () => openSheet('cartStep');
$('sheetBackdrop').onclick = () => {
  // Don't let a tap-out dismiss the confirmation before it's read.
  if ($('confirmStep').classList.contains('hidden')) closeSheet();
};
$('toCheckoutBtn').onclick = () => openSheet('checkoutStep');
$('backToCartBtn').onclick = () => openSheet('cartStep');
$('doneBtn').onclick = () => closeSheet();

// ── Checkout details ────────────────────────────────────────────────

// Location: an explicit either/or. The access code below identifies the
// room server-side — guests never pick (or mistype) a room name. Walk-in
// diners get the 3rd Floor Dining code from staff.
$('locOptions').addEventListener('change', () => {
  const choice = document.querySelector('input[name="loc"]:checked')?.value;
  state.diningIn = choice === 'dining';
  $('noteInput').placeholder = state.diningIn
    ? 'Any allergies or requests? Tell us where you’re seated too.'
    : 'Any allergies, serve time preference, or other requests?';
});

// Concierge deep-links here as /?code=<6 digits> so the guest never retypes
// theirs. The link MUST beat any code saved on the device: shared and staff
// phones carry a stale one, which is exactly how Lexi ended up with the
// Dining Area code while actually in Glamping Tent 1. Format check only —
// place_order re-resolves the code server-side, so a bad one just fails there
// like a mistyped code. The param is stripped either way, so codes don't
// linger in the address bar, screenshots or share sheets.
(() => {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('from')) return;
  const incoming = (params.get('code') || '').trim();
  if (/^\d{6}$/.test(incoming)) localStorage.setItem('tanawin-room-code', incoming);
  // Remember the referral for THIS tab only — sessionStorage, so a shared
  // phone doesn't sprout a "back to Concierge" bar days later.
  if (params.get('from') === 'concierge') sessionStorage.setItem('tanawin-from-concierge', '1');
  params.delete('code');
  params.delete('from');
  const rest = params.toString();
  history.replaceState({}, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
})();

// Returning guests keep their code for the whole stay.
$('accessCode').value = localStorage.getItem('tanawin-room-code') || '';
$('accessCode').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

// GCash panel: show on selection; hide the whole panel if no QR uploaded yet.
$('gcashQr').src = GCASH_QR_URL;
let gcashQrAvailable = true;
$('gcashQr').onerror = () => { gcashQrAvailable = false; $('gcashQr').style.display = 'none'; };

$('payOptions').addEventListener('change', () => {
  const intent = payIntent();
  $('gcashPanel').classList.toggle('hidden', intent !== 'gcash');
  $('sigPanel').classList.toggle('hidden', intent !== 'room');
  if (intent === 'room') sigInit();
});

// ── Signature pad (charge-to-room authorization) ────────────────────

const sigCanvas = $('sigCanvas');
let sigCtx = null, sigHasInk = false;

function sigInit() {
  const rect = sigCanvas.getBoundingClientRect();
  if (!rect.width || sigCtx) return; // size unknown or already initialized
  const dpr = window.devicePixelRatio || 1;
  sigCanvas.width = rect.width * dpr;
  sigCanvas.height = rect.height * dpr;
  sigCtx = sigCanvas.getContext('2d');
  sigCtx.scale(dpr, dpr);
  sigCtx.lineWidth = 2.2;
  sigCtx.lineCap = 'round';
  sigCtx.lineJoin = 'round';
  sigCtx.strokeStyle = '#3D2317';
}

function sigPoint(e) {
  const rect = sigCanvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

sigCanvas.addEventListener('pointerdown', e => {
  sigInit();
  if (!sigCtx) return;
  sigCanvas.setPointerCapture(e.pointerId);
  sigCtx.beginPath();
  sigCtx.moveTo(...sigPoint(e));
  e.preventDefault();
});
sigCanvas.addEventListener('pointermove', e => {
  if (!sigCtx || e.buttons !== 1) return;
  sigCtx.lineTo(...sigPoint(e));
  sigCtx.stroke();
  sigHasInk = true;
  e.preventDefault();
});

function sigClear() {
  if (sigCtx) sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
  sigHasInk = false;
}
$('sigClearBtn').onclick = sigClear;

function sigBlob() {
  return new Promise(resolve => sigCanvas.toBlob(resolve, 'image/png'));
}

function payIntent() {
  return document.querySelector('input[name="pay"]:checked').value;
}

$('proofInput').onchange = () => {
  const f = $('proofInput').files[0] || null;
  state.proofFile = f;
  $('proofLabelText').textContent = f ? `Attached: ${f.name}` : 'Attach payment screenshot';
};

// ── Place order ─────────────────────────────────────────────────────

$('placeOrderBtn').onclick = async () => {
  const choice = document.querySelector('input[name="loc"]:checked')?.value;
  const code = $('accessCode').value.trim();
  if (!choice) {
    toast('Please choose: to your room, or the third-floor dining area?');
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    toast('Please enter your 6-digit access code — it\'s in the ring binder in your room, or ask our staff.');
    return;
  }
  const { count } = cartTotals();
  if (!count) { toast('Your cart is empty.'); return; }
  if (payIntent() === 'room' && !sigHasInk) {
    toast('Please sign in the box to confirm charging to your room.');
    return;
  }

  const btn = $('placeOrderBtn');
  btn.disabled = true;
  btn.textContent = 'Placing order…';

  try {
    let proofUrl = null;
    if (payIntent() === 'gcash' && state.proofFile) {
      const ext = (state.proofFile.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await db.storage.from('gcash-proofs').upload(path, state.proofFile);
      if (upErr) throw upErr;
      proofUrl = path;
    }

    let signaturePath = null;
    if (payIntent() === 'room' && sigHasInk) {
      const blob = await sigBlob();
      signaturePath = `${crypto.randomUUID()}.png`;
      const { error: sigErr } = await db.storage.from('signatures').upload(signaturePath, blob, { contentType: 'image/png' });
      if (sigErr) throw sigErr;
    }

    const items = [...state.cart.values()]
      .map(e => ({ menu_item_id: e.id, qty: e.qty, option: e.option }));
    const { data, error } = await db.rpc('place_order', {
      p_access_code: code,
      p_is_dining_in: state.diningIn,
      p_payment_intent: payIntent(),
      p_note: $('noteInput').value.trim() || null,
      p_gcash_proof_url: proofUrl,
      p_items: items,
      p_signature_url: signaturePath,
    });
    if (error) throw error;

    localStorage.setItem('tanawin-room-code', code); // keep for the stay
    $('confirmNumber').textContent = `#${data.order_number}`;
    $('confirmDetail').textContent = state.diningIn
      ? `${peso(data.total)} — we'll serve it at your table.`
      : `${peso(data.total)} — for ${data.room_number}.`;
    startTracking({ order_id: data.order_id, order_number: data.order_number, status: 'new', ts: Date.now() });
    openSheet('confirmStep');

    state.cart.clear();
    state.proofFile = null;
    sigClear();
    $('proofInput').value = '';
    $('proofLabelText').textContent = 'Attach payment screenshot';
    $('noteInput').value = '';
    saveCart();
    updateCartBar();
    document.querySelectorAll('.item-card').forEach(c => renderItemActions(c, c.dataset.id));
    $('cartBar').classList.add('hidden');
  } catch (err) {
    console.error(err);
    const msg = String(err?.message || '');
    if (msg.includes('access code')) {
      toast('That access code doesn\'t look right — please check the ring binder in your room, or ask our staff.');
    } else if (msg.includes('dining in only')) {
      toast('That code works for dining in only — for room service, use your room\'s own code.');
    } else if (msg.includes('too many orders')) {
      toast('That\'s a lot of orders this hour! Please ask our staff for help with this one.');
    } else {
      toast('Something went wrong placing your order. Please try again, or ask our staff for help.');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Place order';
  }
};

// ── Order status tracker ────────────────────────────────────────────
// Guests can't read the orders table; get_order_status is a status-only
// peephole keyed by the order's unguessable id. Auto-polls while the
// page is open, with a manual refresh as backup.

const TRACK_KEY = 'tanawin-track-order';
const TRACK_TTL = 3 * 60 * 60 * 1000; // stop tracking 3h-old orders
let trackTimer = null;

const STEP_ORDER = ['new', 'preparing', 'on_the_way', 'delivered'];
const STATUS_HEADLINE = {
  new: 'Order received!',
  preparing: 'Being prepped 👨‍🍳',
  on_the_way: 'Done prepping — on its way to you 🛎',
  delivered: 'Delivered — enjoy! 😋',
  cancelled: 'Order cancelled',
};
const BANNER_TEXT = {
  new: n => `Order #${n} — received, in the queue · tap to view`,
  preparing: n => `Order #${n} — being prepped 👨‍🍳 · tap to view`,
  on_the_way: n => `Order #${n} — on its way to you 🛎`,
  delivered: n => `Order #${n} — delivered, enjoy! 😋`,
};
// the moment worth celebrating for the guest is "it's coming", not the
// staff's later confirmation tap
const isFinalStep = s => s === 'on_the_way' || s === 'delivered';

function trackedOrder() {
  try {
    const t = JSON.parse(localStorage.getItem(TRACK_KEY) || 'null');
    if (!t || Date.now() - t.ts > TRACK_TTL) return null;
    return t;
  } catch { return null; }
}

function startTracking(order) {
  localStorage.setItem(TRACK_KEY, JSON.stringify(order));
  renderTracker(order.status);
  scheduleTrackerPoll();
}

function stopTracking() {
  localStorage.removeItem(TRACK_KEY);
  clearTimeout(trackTimer);
  $('orderBanner').classList.add('hidden');
}

function renderTracker(status) {
  const t = trackedOrder();
  if (!t) return;
  // confirm sheet steps
  const stepIdx = STEP_ORDER.indexOf(status);
  document.querySelectorAll('#trackerSteps li').forEach(li => {
    const idx = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.toggle('done', stepIdx > idx || status === 'delivered' && idx === stepIdx);
    li.classList.toggle('current', idx === stepIdx && status !== 'delivered');
  });
  $('trackerHeading').textContent = STATUS_HEADLINE[status] || status;
  $('confirmStep').classList.toggle('is-ready', isFinalStep(status));
  // cancelling is the guest's own only until the kitchen picks it up
  $('cancelOrderBtn').classList.toggle('hidden', status !== 'new');
  // banner (only when the sheet is closed and the order is still in flight)
  const banner = $('orderBanner');
  if (status === 'cancelled') {
    banner.classList.add('hidden');
  } else {
    banner.textContent = (BANNER_TEXT[status] || BANNER_TEXT.new)(t.order_number);
    banner.classList.toggle('ready', isFinalStep(status));
    banner.classList.toggle('hidden', !$('cartSheet').classList.contains('hidden'));
  }
}

// The guest cancelling their own order. The server is the authority on whether
// it's still allowed — a race with staff tapping "Start prepping" is entirely
// possible, so a refusal is treated as information, not an error.
$('cancelOrderBtn').onclick = async () => {
  const t = trackedOrder();
  if (!t) return;
  if (!confirm('Cancel your order? This can only be undone by asking our staff.')) return;
  const btn = $('cancelOrderBtn');
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
  try {
    const { data, error } = await db.rpc('cancel_order', { p_order_id: t.order_id });
    if (error) throw error;
    if (data?.ok) {
      t.status = 'cancelled';
      localStorage.setItem(TRACK_KEY, JSON.stringify(t));
      renderTracker('cancelled');
      toast('Your order has been cancelled.');
    } else if (data?.reason === 'already_started') {
      renderTracker(data.status || 'preparing');
      toast('Our kitchen has already started this one — please ask our staff.');
    } else {
      toast('We couldn’t cancel that — please ask our staff.');
    }
  } catch (err) {
    console.error(err);
    toast('Couldn’t reach us just now — check your connection, or ask our staff.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Cancel my order';
  }
};

async function refreshTrackedStatus() {
  const t = trackedOrder();
  if (!t) return;
  const { data, error } = await db.rpc('get_order_status', { p_order_id: t.order_id });
  if (error || !data) return; // transient — next poll retries
  if (data.status !== t.status) {
    t.status = data.status;
    localStorage.setItem(TRACK_KEY, JSON.stringify(t));
    // buzz when the food actually leaves the kitchen — that's the news the
    // guest is waiting for, not the staff's later "handed over" tap
    if (data.status === 'on_the_way' && navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }
  renderTracker(t.status);
  if (t.status === 'delivered' || t.status === 'cancelled') {
    // final state: keep it on screen ~10 min, then clear quietly
    if (Date.now() - t.ts > 10 * 60 * 1000) stopTracking();
    else scheduleTrackerPoll(60000);
  } else {
    scheduleTrackerPoll();
  }
}

function scheduleTrackerPoll(ms = 12000) {
  clearTimeout(trackTimer);
  if (trackedOrder()) trackTimer = setTimeout(refreshTrackedStatus, ms);
}

$('trackerRefreshBtn').onclick = () => refreshTrackedStatus();
$('orderBanner').onclick = () => { openSheet('confirmStep'); renderTracker(trackedOrder()?.status || 'new'); };
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshTrackedStatus(); // catch up after the phone napped
});

// resume tracking after a reload
(function resumeTracking() {
  const t = trackedOrder();
  if (!t) return;
  $('confirmNumber').textContent = `#${t.order_number}`;
  $('confirmDetail').textContent = '';
  renderTracker(t.status);
  refreshTrackedStatus();
})();

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

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ── Admin preview ───────────────────────────────────────────────────
// Staff open this page from the dashboard's "👁 Guest view" chip. Nothing
// about the guest experience changes — the only addition is a banner back
// to the dashboard, so staff aren't stranded with just the URL bar.
//
// The flag alone does nothing: it needs a signed-in staff session, which
// index.html can see because staff.html stores it in localStorage on the
// same origin. Guests have no session, so ?preview=1 is inert for them.
// (Reusing the existing `db` client on purpose — a second createClient on
// one page clobbers the shared session.)
async function showPreviewBannerIfStaff() {
  if (new URLSearchParams(location.search).get('preview') !== '1') return;
  const { data: { session } } = await db.auth.getSession();
  if (!session) return;
  const bar = document.createElement('div');
  bar.className = 'preview-bar';
  bar.innerHTML = `<strong>👁 Admin preview</strong>
    <span>this is exactly what guests see</span>
    <a href="staff.html">← Back to dashboard</a>`;
  document.body.appendChild(bar);
  // keep the cart bar and banner clear of the fixed strip
  document.body.style.paddingBottom = `${bar.offsetHeight + 8}px`;
}

// ── Back to Concierge ───────────────────────────────────────────────
// Only for guests who arrived via Concierge's "Hungry? Order food" card
// (?from=concierge). A QR-poster or bookmark visitor has never seen
// Concierge, so offering them a way "back" would point at a door they've
// never walked through — they must never see this.
//
// Sticky at the top rather than fixed at the bottom: the bottom already
// carries the cart bar, the order-status banner, toasts and the sheets.
// Concierge remembers the guest's code itself, so a bare link is enough.
const CONCIERGE_URL = 'https://tanawin-concierge.tanawinbnb.workers.dev/';

function showConciergeBarIfReferred() {
  if (sessionStorage.getItem('tanawin-from-concierge') !== '1') return;
  const bar = document.createElement('a');
  bar.className = 'concierge-bar';
  bar.href = CONCIERGE_URL;
  bar.innerHTML = '← Back to Tanawin Concierge<span>Wifi, house info, and guest services</span>';
  document.body.insertBefore(bar, document.body.firstChild);
  // the category nav sticks BELOW this bar instead of under it
  document.documentElement.style.setProperty('--concierge-bar-h', `${bar.offsetHeight}px`);
}

loadMenu();
showPreviewBannerIfStaff();
showConciergeBarIfReferred();
