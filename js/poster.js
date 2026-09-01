/* Tanawin Menu — QR poster page.
 *
 * This was an inline <script> in poster.html until 2026-09-01. It lives in its
 * own file now for one reason: an inline script forces 'unsafe-inline' into
 * script-src, and that single word would undo most of what the CSP is for
 * across the whole site. index.html and staff.html had no inline script to
 * begin with, so poster was the only thing standing between Menu and a strict
 * policy.
 */
(function () {
  // The print button was an onclick attribute, which CSP blocks for the same
  // reason as an inline <script>.
  var printBtn = document.getElementById('printBtn');
  if (printBtn) printBtn.onclick = function () { window.print(); };

  // Captions come from settings (staff-only table). Opened from the staff
  // dashboard the auth session carries over; without one, defaults stand.
  var db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  (async () => {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const { data } = await db.from('settings').select('key, value')
      .in('key', ['qr_text_above', 'qr_text_below']);
    (data || []).forEach(r => {
      if (r.key === 'qr_text_above' && r.value) document.getElementById('textAbove').textContent = r.value;
      if (r.key === 'qr_text_below' && r.value) document.getElementById('textBelow').textContent = r.value;
    });
  })();
})();
