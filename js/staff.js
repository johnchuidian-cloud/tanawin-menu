// Tanawin Menu — staff dashboard logic.

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const FLOWER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><g transform="translate(16 16)"><ellipse rx="1.7" ry="7.2" cy="-8.2" transform="rotate(0)"/><ellipse rx="1.5" ry="5.6" cy="-6.6" transform="rotate(47)"/><ellipse rx="1.6" ry="6.8" cy="-7.6" transform="rotate(88)"/><ellipse rx="1.4" ry="5.2" cy="-6.2" transform="rotate(128)"/><ellipse rx="1.6" ry="6.4" cy="-7.2" transform="rotate(171)"/><ellipse rx="1.5" ry="5.8" cy="-6.8" transform="rotate(217)"/><ellipse rx="1.7" ry="7.0" cy="-7.9" transform="rotate(262)"/><ellipse rx="1.4" ry="5.4" cy="-6.4" transform="rotate(309)"/><circle r="2.1"/></g></svg>`;
document.querySelectorAll('[data-flower]').forEach(el => { el.innerHTML = FLOWER_SVG; });

const $ = id => document.getElementById(id);

const state = {
  orders: new Map(),      // id -> order row (with items)
  filter: 'active',
  menu: [],
  editingId: null,        // menu item being edited (null = new)
  pendingPhoto: null,     // File chosen in the edit sheet
  photoRemoved: false,
  channel: null,
};

// ── Auth ────────────────────────────────────────────────────────────

async function boot() {
  const { data: { session } } = await db.auth.getSession();
  session ? showApp() : showLogin();
}

function showLogin() {
  $('loginView').classList.remove('hidden');
  $('appView').classList.add('hidden');
}

async function showApp() {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  await Promise.all([loadOrders(), loadMenu(), loadSettings()]);
  subscribeOrders();
}

// PIN login, consistent with the other Tanawin apps. Under the hood the PIN
// maps to the shared staff auth account so RLS still sees `authenticated`.
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  $('loginError').classList.add('hidden');
  const pin = $('loginPin').value.trim();
  const { error } = await db.auth.signInWithPassword({
    email: 'staff@tanawin.menu',
    password: `tanawin-menu-v1:${pin}`,
  });
  if (error) {
    $('loginPin').value = '';
    $('loginError').textContent = 'Wrong PIN — try again.';
    $('loginError').classList.remove('hidden');
    return;
  }
  primeChime(); // user gesture: unlock audio for order alerts
  showApp();
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
    ['orders', 'menu', 'settings'].forEach(t =>
      $(`tab-${t}`).classList.toggle('hidden', t !== btn.dataset.tab));
  };
});

// ── Orders: load, realtime, render ──────────────────────────────────

async function loadOrders() {
  const { data, error } = await db
    .from('orders')
    .select('*, order_items(item_name, qty, line_total)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) { toast('Could not load orders.'); console.error(error); return; }
  state.orders.clear();
  data.forEach(o => state.orders.set(o.id, o));
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
        if (data) {
          state.orders.set(data.id, data);
          renderOrders();
          chime();
          toast(`New order #${data.order_number} — ${data.is_dining_in ? 'Dining in' : 'Room ' + data.room_number}`);
        }
      }, 600);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, payload => {
      const existing = state.orders.get(payload.new.id);
      if (existing) {
        state.orders.set(payload.new.id, { ...existing, ...payload.new });
        renderOrders();
      }
    })
    .subscribe();
}

document.querySelectorAll('.filter-row .cat-pill').forEach(pill => {
  pill.onclick = () => {
    state.filter = pill.dataset.filter;
    document.querySelectorAll('.filter-row .cat-pill').forEach(p =>
      p.classList.toggle('active', p === pill));
    renderOrders();
  };
});

function renderOrders() {
  const list = $('ordersList');
  const active = ['new', 'preparing'];
  const rows = [...state.orders.values()]
    .filter(o => state.filter === 'active' ? active.includes(o.status) : !active.includes(o.status))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const activeCount = [...state.orders.values()].filter(o => active.includes(o.status)).length;
  $('activeBadge').textContent = activeCount;
  $('activeBadge').classList.toggle('hidden', activeCount === 0);

  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = `<p class="empty-note">${state.filter === 'active'
      ? 'No active orders — new ones appear here instantly.' : 'Nothing here yet.'}</p>`;
    return;
  }
  rows.forEach(o => list.appendChild(orderCard(o)));
}

function orderCard(o) {
  const card = document.createElement('article');
  card.className = `order-card status-${o.status}`;

  const items = (o.order_items || [])
    .map(i => `<li><span>${esc(i.item_name)} × ${i.qty}</span><span>${peso(i.line_total)}</span></li>`)
    .join('');

  const payChip = o.payment_intent === 'room'
    ? '<span class="chip">Charge to room</span>'
    : o.payment_intent === 'gcash'
      ? '<span class="chip pay-gcash">GCash / Bank</span>'
      : '<span class="chip pay-cash">Cash</span>';

  const doneChip = o.status === 'delivered' ? '<span class="chip status-chip-delivered">Delivered</span>'
    : o.status === 'cancelled' ? '<span class="chip status-chip-cancelled">Cancelled</span>' : '';

  card.innerHTML = `
    <div class="order-top">
      <span class="order-num">#${o.order_number}</span>
      <span class="order-time">${timeLabel(o.created_at)}</span>
    </div>
    <div class="order-chips">
      <span class="chip room-chip">${o.is_dining_in ? 'Dining in' : 'Room ' + esc(o.room_number || '?')}</span>
      ${payChip}${doneChip}
    </div>
    <ul class="order-items">${items}</ul>
    ${o.note ? `<div class="order-note">📝 ${esc(o.note)}</div>` : ''}
    <div class="order-total-row"><span>Total</span><span>${peso(o.total)}</span></div>
    <div class="proof-slot"></div>
    <div class="order-actions"></div>`;

  if (o.gcash_proof_url) {
    db.storage.from('gcash-proofs').createSignedUrl(o.gcash_proof_url, 3600).then(({ data }) => {
      if (data?.signedUrl) {
        card.querySelector('.proof-slot').innerHTML =
          `<a href="${data.signedUrl}" target="_blank"><img class="proof-thumb" src="${data.signedUrl}" alt="Payment proof"></a>`;
      }
    });
  }

  const actions = card.querySelector('.order-actions');
  if (o.status === 'new') {
    actions.appendChild(actionBtn('Start preparing', () => setStatus(o.id, 'preparing')));
    actions.appendChild(cancelBtn(o.id));
  } else if (o.status === 'preparing') {
    actions.appendChild(actionBtn('Mark delivered', () => setStatus(o.id, 'delivered')));
    actions.appendChild(cancelBtn(o.id));
  }
  return card;
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

async function setStatus(id, status) {
  const { error } = await db.from('orders').update({ status }).eq('id', id);
  if (error) { toast('Update failed — try again.'); console.error(error); return; }
  const o = state.orders.get(id);
  if (o) { o.status = status; renderOrders(); }
}

// ── Menu management ─────────────────────────────────────────────────

async function loadMenu() {
  const { data, error } = await db.from('menu_items')
    .select('*').order('sort_order').order('name');
  if (error) { toast('Could not load menu.'); console.error(error); return; }
  state.menu = data;
  renderMenuList();
}

function renderMenuList() {
  const wrap = $('menuList');
  wrap.innerHTML = '';
  CATEGORIES.forEach(cat => {
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
      <small>${peso(m.price)}${m.is_available ? '' : ' · hidden from guests'}</small>
    </div>
    <div class="menu-row-actions">
      <button class="icon-btn" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" title="Move down" ${idx === catItems.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn" title="Edit">✎</button>
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

$('itemCategory').innerHTML = CATEGORIES.map(c => `<option>${c}</option>`).join('');

$('addItemBtn').onclick = () => openItemSheet(null);

function openItemSheet(m) {
  state.editingId = m ? m.id : null;
  state.pendingPhoto = null;
  state.photoRemoved = false;
  $('itemSheetTitle').textContent = m ? 'Edit item' : 'New item';
  $('itemName').value = m ? m.name : '';
  $('itemCategory').value = m ? m.category : CATEGORIES[0];
  $('itemDescription').value = m ? (m.description || '') : '';
  $('itemPrice').value = m ? m.price : '';
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
    const fields = {
      name: $('itemName').value.trim(),
      category: $('itemCategory').value,
      description: $('itemDescription').value.trim() || null,
      price: Number($('itemPrice').value),
      is_available: $('itemAvailable').checked,
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

// ── Settings ────────────────────────────────────────────────────────

async function loadSettings() {
  const { data, error } = await db.from('settings').select('key, value');
  if (error) { console.error(error); return; }
  const map = Object.fromEntries(data.map(r => [r.key, r.value]));
  $('smsNumbers').value = map.staff_sms_numbers || '';
  $('smsEnabled').checked = map.sms_enabled === 'true';
  $('settingsQr').src = `${GCASH_QR_URL}?t=${Date.now()}`;
}

$('settingsForm').onsubmit = async e => {
  e.preventDefault();
  const updates = [
    { key: 'staff_sms_numbers', value: $('smsNumbers').value.trim() },
    { key: 'sms_enabled', value: String($('smsEnabled').checked) },
  ].map(r => ({ ...r, updated_at: new Date().toISOString() }));
  const { error } = await db.from('settings').upsert(updates);
  if (error) { toast('Save failed.'); console.error(error); return; }
  toast('Settings saved.');
};

$('qrUpload').onchange = async () => {
  const f = $('qrUpload').files[0];
  if (!f) return;
  const { error } = await db.storage.from('menu-images')
    .upload('gcash-qr.jpg', f, { upsert: true, contentType: f.type || 'image/jpeg' });
  if (error) { toast('QR upload failed.'); console.error(error); return; }
  $('settingsQr').src = `${GCASH_QR_URL}?t=${Date.now()}`;
  toast('Payment QR replaced.');
};

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
