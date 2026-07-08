-- Editable captions for the printable guest-room QR poster (poster.html).
insert into public.settings (key, value) values
  ('qr_text_above', 'Hungry? Order from your room!'),
  ('qr_text_below', 'Scan with your phone camera to browse our menu and order — we''ll bring it right to you.')
on conflict (key) do nothing;
