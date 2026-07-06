// Tanawin Menu — public client config.
// The anon key is safe to ship: it only grants what RLS allows
// (read available menu items, place orders via the place_order function).

const SUPABASE_URL = 'https://lkeuiquqogtevsgvaddf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxrZXVpcXVxb2d0ZXZzZ3ZhZGRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNDIxNDUsImV4cCI6MjA5ODkxODE0NX0.nw_5E2F2OsQhT3DlRcigO8Vm9uYkgM80UqB7dMx5X8w';

// GCash QR lives as a public asset in menu-images (handoff §8 decision);
// the checkout hides the GCash panel if this image doesn't exist yet.
const GCASH_QR_URL = `${SUPABASE_URL}/storage/v1/object/public/menu-images/gcash-qr.jpg`;

// Fixed display order for the 7 categories.
const CATEGORIES = ['Chicken', 'Seafood', 'Vegetables', 'Silogs', 'Crepes', 'Pika-Pika', 'Beverages'];

// Staff roster — mirrors kitchen_users in the Kitchen app (same people, same
// PINs). Each maps to a hidden auth account <slug>@tanawin.menu; staff changes
// need both this list and the auth account updated (ask Claude in a build chat).
const STAFF_ROSTER = [
  { name: 'Lexi', role: 'admin', slug: 'lexi' },
  { name: 'Monique', role: 'staff', slug: 'monique' },
  { name: 'Disang', role: 'staff', slug: 'disang' },
  { name: 'Sherill', role: 'staff', slug: 'sherill' },
  { name: 'Janice', role: 'staff', slug: 'janice' },
];
