// Tanawin Menu — staff dashboard logic.

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const FLOWER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><g transform="translate(16 16)"><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(45)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(90)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(135)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(180)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(225)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(270)"/><path d="M0 0 C-2.7 -3 -2.4 -8.7 0 -11 2.4 -8.7 2.7 -3 0 0 Z" transform="rotate(315)"/><circle r="2.9"/></g></svg>`;
document.querySelectorAll('[data-flower]').forEach(el => { el.innerHTML = FLOWER_SVG; });

const $ = id => document.getElementById(id);

const state = {
  orders: new Map(),      // id -> order row (with items)
  filter: 'active',
  menu: [],
  categories: CATEGORIES, // replaced by the categories table on load
  editingId: null,        // menu item being edited (null = new)
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
  const hubLink = $('hubLink');
  hubLink.classList.remove('hidden');
  // admins get the full hub (incl. Payroll); staff get the staff launcher
  hubLink.href = isAdmin
    ? 'https://tanawin-hub.tanawinbnb.workers.dev/'
    : 'https://tanawin-hub.tanawinbnb.workers.dev/staff';
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  const tasks = [loadOrders(), loadMenu(), loadRooms(), loadSettings()];
  if (isAdmin) tasks.push(loadStaff());
  await Promise.all(tasks);
  subscribeOrders();
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

  const doneChip = o.status === 'delivered'
    ? `<span class="chip status-chip-delivered">Ready · sent out${o.handled_by ? ' by ' + esc(o.handled_by) : ''}</span>`
    : o.status === 'cancelled'
      ? `<span class="chip status-chip-cancelled">Cancelled${o.cancelled_by ? ' by ' + esc(o.cancelled_by) : ''}</span>` : '';

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

  if (o.signature_url) {
    db.storage.from('signatures').createSignedUrl(o.signature_url, 3600).then(({ data }) => {
      if (data?.signedUrl) {
        card.querySelector('.proof-slot').insertAdjacentHTML('beforeend',
          `<div class="sig-label">✍ Signed — charge to room</div>
           <img class="sig-thumb" src="${data.signedUrl}" alt="Guest signature">`);
      }
    });
  }

  const actions = card.querySelector('.order-actions');
  if (o.status === 'new') {
    actions.appendChild(actionBtn('Start prepping', () => setStatus(o.id, 'preparing')));
    actions.appendChild(cancelBtn(o.id));
  } else if (o.status === 'preparing') {
    actions.appendChild(actionBtn('Order ready 🛎', () => setStatus(o.id, 'delivered')));
    actions.appendChild(cancelBtn(o.id));
  } else if (o.status === 'cancelled') {
    // accidental cancels happen — any staff can bring the order back
    actions.appendChild(actionBtn('Uncancel — back to queue', () => setStatus(o.id, 'new')));
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
  const patch = { status };
  if (status === 'delivered') patch.handled_by = currentName;
  if (status === 'cancelled') patch.cancelled_by = currentName;
  if (status === 'new') patch.cancelled_by = null; // uncancel wipes the blame
  const { error } = await db.from('orders').update(patch).eq('id', id);
  if (error) { toast('Update failed — try again.'); console.error(error); return; }
  const o = state.orders.get(id);
  if (o) { Object.assign(o, patch); renderOrders(); }
}

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
      'Status': o.status, 'Payment': o.payment_intent,
      'Total (PHP)': Number(o.total),
      'Items': (o.order_items || []).map(i => `${i.item_name} x${i.qty}`).join('; '),
      'Note': o.note || '', 'Ready by': o.handled_by || '', 'Cancelled by': o.cancelled_by || '',
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

// ── Rooms: access codes ─────────────────────────────────────────────

async function loadRooms() {
  const { data, error } = await db.from('rooms')
    .select('name, code, kind, is_active').order('created_at');
  if (error) { console.error(error); return; }
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
      ${canToggleRole ? `<button class="icon-btn role-btn">${s.role === 'admin' ? 'Revoke<br>admin' : 'Make<br>admin'}</button>` : ''}
      ${canSetPin ? `<button class="icon-btn pin-btn" title="Change PIN">New<br>PIN</button>` : ''}
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
