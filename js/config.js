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
