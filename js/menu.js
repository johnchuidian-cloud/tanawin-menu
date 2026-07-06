// Tanawin Menu — guest surface logic.

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// The flower accent inline (uses currentColor, which <img> can't inherit).
const FLOWER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><g transform="translate(16 16)"><ellipse rx="1.7" ry="7.2" cy="-8.2" transform="rotate(0)"/><ellipse rx="1.5" ry="5.6" cy="-6.6" transform="rotate(47)"/><ellipse rx="1.6" ry="6.8" cy="-7.6" transform="rotate(88)"/><ellipse rx="1.4" ry="5.2" cy="-6.2" transform="rotate(128)"/><ellipse rx="1.6" ry="6.4" cy="-7.2" transform="rotate(171)"/><ellipse rx="1.5" ry="5.8" cy="-6.8" transform="rotate(217)"/><ellipse rx="1.7" ry="7.0" cy="-7.9" transform="rotate(262)"/><ellipse rx="1.4" ry="5.4" cy="-6.4" transform="rotate(309)"/><circle r="2.1"/></g></svg>`;
document.querySelectorAll('[data-flower]').forEach(el => { el.innerHTML = FLOWER_SVG; });

const $ = id => document.getElementById(id);

const state = {
  items: new Map(),          // id -> menu item row
  cart: new Map(),           // id -> qty
  diningIn: false,
  proofFile: null,
};

// ── Load & render the menu ──────────────────────────────────────────

async function loadMenu() {
  const { data, error } = await db
    .from('menu_items')
    .select('id, name, category, description, image_url, price, sort_order')
    .order('sort_order')
    .order('name');

  if (error) {
    $('loading').innerHTML = '<p>Could not load the menu. Please check your connection and refresh.</p>';
    console.error(error);
    return;
  }

  data.forEach(it => state.items.set(it.id, it));
  renderMenu(data);
  restoreCart();
}

function renderMenu(items) {
  const byCat = new Map(CATEGORIES.map(c => [c, []]));
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
      <div class="item-price">${peso(it.price)}</div>
    </div>
    <div class="item-actions"></div>`;

  renderItemActions(card, it.id);
  return card;
}

function renderItemActions(card, id) {
  const box = card.querySelector('.item-actions');
  const qty = state.cart.get(id) || 0;
  if (!qty) {
    box.innerHTML = `<button class="add-btn" aria-label="Add to order">+</button>`;
    box.querySelector('button').onclick = () => setQty(id, 1);
  } else {
    box.innerHTML = `
      <div class="qty-stepper">
        <button aria-label="Remove one">−</button><span>${qty}</span><button aria-label="Add one">+</button>
      </div>`;
    const [minus, plus] = box.querySelectorAll('button');
    minus.onclick = () => setQty(id, qty - 1);
    plus.onclick = () => setQty(id, qty + 1);
  }
}

// ── Cart ────────────────────────────────────────────────────────────

function setQty(id, qty) {
  if (qty <= 0) state.cart.delete(id);
  else state.cart.set(id, Math.min(qty, 50));

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
  for (const [id, qty] of state.cart) {
    const it = state.items.get(id);
    if (!it) continue;
    count += qty;
    total += it.price * qty;
  }
  return { count, total };
}

function updateCartBar() {
  const { count, total } = cartTotals();
  $('cartBar').classList.toggle('hidden', count === 0);
  $('cartBarCount').textContent = count;
  $('cartBarTotal').textContent = peso(total);
}

function renderCartLines() {
  const ul = $('cartLines');
  ul.innerHTML = '';
  for (const [id, qty] of state.cart) {
    const it = state.items.get(id);
    if (!it) continue;
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="cart-line-name">${esc(it.name)}<small>${peso(it.price)} each</small></div>
      <div class="qty-stepper">
        <button aria-label="Remove one">−</button><span>${qty}</span><button aria-label="Add one">+</button>
      </div>
      <strong>${peso(it.price * qty)}</strong>`;
    const [minus, plus] = li.querySelectorAll('button');
    minus.onclick = () => setQty(id, qty - 1);
    plus.onclick = () => setQty(id, qty + 1);
    ul.appendChild(li);
  }
  $('cartTotal').textContent = peso(cartTotals().total);
}

function saveCart() {
  localStorage.setItem('tanawin-cart', JSON.stringify([...state.cart]));
}

function restoreCart() {
  try {
    const saved = JSON.parse(localStorage.getItem('tanawin-cart') || '[]');
    saved.forEach(([id, qty]) => {
      if (state.items.has(id)) state.cart.set(id, qty);
    });
  } catch { /* fresh start */ }
  state.cart.forEach((_, id) => {
    const card = document.querySelector(`.item-card[data-id="${id}"]`);
    if (card) renderItemActions(card, id);
  });
  updateCartBar();
}

// ── Sheet navigation ────────────────────────────────────────────────

function openSheet(step) {
  $('sheetBackdrop').classList.remove('hidden');
  $('cartSheet').classList.remove('hidden');
  ['cartStep', 'checkoutStep', 'confirmStep'].forEach(s =>
    $(s).classList.toggle('hidden', s !== step));
  if (step === 'cartStep') renderCartLines();
}

function closeSheet() {
  $('sheetBackdrop').classList.add('hidden');
  $('cartSheet').classList.add('hidden');
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

// Location: an explicit either/or — picking "To my room" reveals the
// room-name field; "Dining in" needs nothing more (one universal QR,
// no per-table codes — staff serve the dining area directly).
$('locOptions').addEventListener('change', () => {
  const choice = document.querySelector('input[name="loc"]:checked')?.value;
  state.diningIn = choice === 'dining';
  $('roomInput').classList.toggle('hidden', choice !== 'room');
  if (choice === 'room') $('roomInput').focus();
  else $('roomInput').value = '';
  $('noteInput').placeholder = state.diningIn
    ? 'e.g. we’re at the table by the garden'
    : 'e.g. less spicy, extra rice';
});

// GCash panel: show on selection; hide the whole panel if no QR uploaded yet.
$('gcashQr').src = GCASH_QR_URL;
let gcashQrAvailable = true;
$('gcashQr').onerror = () => { gcashQrAvailable = false; $('gcashQr').style.display = 'none'; };

$('payOptions').addEventListener('change', () => {
  const isGcash = payIntent() === 'gcash';
  $('gcashPanel').classList.toggle('hidden', !isGcash);
});

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
  const room = $('roomInput').value.trim();
  if (!choice) {
    toast('Please choose: to your room, or dining in?');
    return;
  }
  if (choice === 'room' && !room) {
    toast('Please tell us which room you\'re in.');
    return;
  }
  const { count } = cartTotals();
  if (!count) { toast('Your cart is empty.'); return; }

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

    const items = [...state.cart].map(([menu_item_id, qty]) => ({ menu_item_id, qty }));
    const { data, error } = await db.rpc('place_order', {
      p_room_number: state.diningIn ? null : room,
      p_is_dining_in: state.diningIn,
      p_payment_intent: payIntent(),
      p_note: $('noteInput').value.trim() || null,
      p_gcash_proof_url: proofUrl,
      p_items: items,
    });
    if (error) throw error;

    $('confirmNumber').textContent = `#${data.order_number}`;
    $('confirmDetail').textContent = state.diningIn
      ? `${peso(data.total)} — we'll serve it at your table.`
      : `${peso(data.total)} — on its way to ${room}.`;
    openSheet('confirmStep');

    state.cart.clear();
    state.proofFile = null;
    $('proofInput').value = '';
    $('proofLabelText').textContent = 'Attach payment screenshot';
    $('noteInput').value = '';
    saveCart();
    updateCartBar();
    document.querySelectorAll('.item-card').forEach(c => renderItemActions(c, c.dataset.id));
    $('cartBar').classList.add('hidden');
  } catch (err) {
    console.error(err);
    toast('Something went wrong placing your order. Please try again, or ask our staff for help.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Place order';
  }
};

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

loadMenu();
