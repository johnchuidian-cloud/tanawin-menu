-- Seed the real menu from "Tanawin Food Menu.pdf" (menu dated 2026.06.28 /
-- 2026.07.07). Replaces the 9 placeholder items. 36 items; Seafood Medley is
-- seeded hidden (catering / advance orders only).
-- Option prices verified against the PDF's price columns (for 2 / for 6 / for 9,
-- Glass / Pitcher). Pork Sisig tiers confirmed by Lexi: 299 = for 2, 499 = for 6.

delete from public.menu_items;

insert into public.menu_items (name, category, description, price, sort_order, options, is_available) values
-- Chicken
('Tinanglaran (Native Chicken in Lemongrass)', 'Chicken', 'Native chicken simmered with lemongrass and local spices', 479, 1,
 '[{"label":"for 2","price":479},{"label":"for 6","price":1099},{"label":"for 9","price":1699}]', true),
('Adobo sa Luyang Dilaw', 'Chicken', 'A healthy twist on the classic Filipino adobo, cooked with turmeric (luyang dilaw)', 469, 2,
 '[{"label":"for 2","price":469},{"label":"for 6","price":999},{"label":"for 9","price":1599}]', true),
('Classic Fried Chicken', 'Chicken', 'Crispy, golden-fried chicken, perfectly seasoned and juicy on the inside', 439, 3,
 '[{"label":"for 2","price":439},{"label":"for 6","price":799},{"label":"for 9","price":1199}]', true),

-- Seafood
('Shrimp Gambas', 'Seafood', 'Tender shrimp sautéed in garlic and chili — a flavorful and savory dish with a hint of spice', 709, 1,
 '[{"label":"for 2","price":709},{"label":"for 6","price":1599}]', true),
('Adobong Pusit w/ Vegetables', 'Seafood', 'Squid simmered in savory adobo sauce with garlic and fresh vegetables', 609, 2,
 '[{"label":"for 2","price":609},{"label":"for 6","price":1299}]', true),
('Tamarind Salmon Soup', 'Seafood', 'Salmon cooked in a tangy tamarind broth with tomatoes and vegetables', 859, 3,
 '[{"label":"for 2","price":859},{"label":"for 6","price":1799}]', true),
('Tamarind Bangus Soup', 'Seafood', 'Milkfish cooked in a tangy tamarind broth with tomatoes and vegetables', 529, 4,
 '[{"label":"for 2","price":529},{"label":"for 6","price":1099}]', true),
('Tahong ng Orani', 'Seafood', 'Fresh mussels from Orani processed immediately to seal in freshness; cooked in garlic and herbs. Served with pasta and bread', 450, 5,
 '[{"label":"for 2","price":450},{"label":"for 6","price":990},{"label":"for 9","price":1300}]', true),
('Bangus Sisig', 'Seafood', 'Milkfish (boneless bangus) on a sizzling plate with onions and chili. Pescetarian beer match!', 450, 6,
 '[{"label":"for 2","price":450},{"label":"for 6","price":990},{"label":"for 9","price":1300}]', true),
('Seafood Medley', 'Seafood', 'Freshly caught seafood from Orani: local varieties of crab, prawn, mussels, squid, and fish. Served in a refreshing sauce with herbs and corn on the cob. For catering — advance orders only. ₱500/head, minimum of 10.', 500, 7,
 null, false),

-- Vegetables
('Chopsuey', 'Vegetables', 'Stir fried vegetables with shrimp, quail eggs, and chicken liver in a light sauce', 389, 1,
 '[{"label":"for 2","price":389},{"label":"for 6","price":869}]', true),
('Garlic Kangkong', 'Vegetables', 'Fresh water spinach sautéed in garlic', 209, 2,
 '[{"label":"for 2","price":209},{"label":"for 6","price":289}]', true),

-- Soup & Pancit
('Bulalo ng Bataan', 'Soup & Pancit', 'Beef bone marrow and chunks, corn on the cob, beans, cabbage, petchay, in a slow cooked broth', 400, 1,
 '[{"label":"for 2","price":400},{"label":"for 6","price":1050},{"label":"for 9","price":1400}]', true),
('Pancit Canton or Bihon', 'Soup & Pancit', 'Your choice of canton or bihon with chicken, shrimp, and assorted fresh vegetables', 400, 2,
 '[{"label":"Canton · for 2","price":400},{"label":"Canton · for 6","price":640},{"label":"Canton · for 9","price":920},{"label":"Bihon · for 2","price":400},{"label":"Bihon · for 6","price":640},{"label":"Bihon · for 9","price":920}]', true),

-- Crepes
('Corned Beef Cream Cheese', 'Crepes', 'Delimondo Ranch corned beef with cream cheese for a familiar umami flavor', 299, 1, null, true),
('Tuna Bechamel', 'Crepes', 'Tuna with homemade bechamel (a milky buttery cream) sauce', 299, 2, null, true),
('Vegetarian Lumpia Crepe', 'Crepes', 'Fresh veg filled with carrots, singkamas (jicama), cucumber and a peanut sauce', 299, 3, null, true),
('Lemon Butter', 'Crepes', 'Classic and light. Crepe filled with pure butter, lemon, and sugar', 149, 4, null, true),
('Uber Ube Cream Cheese', 'Crepes', 'Ube jam and cream cheese — our ube-cheese combination. Must try if you like this combo!', 149, 5, null, true),
('Banana Peanut Butter', 'Crepes', 'Comfort combination of ripe local banana and peanut butter', 149, 6, null, true),
('Combo Crepe', 'Crepes', 'One savory + one sweet crepe for a sweet deal', 419, 7, null, true),

-- Pika-Pika
('Nachos', 'Pika-Pika', 'Tortilla chips with refried beans, salsa, cheese, and peppers', 399, 1, null, true),
('Pork Sisig', 'Pika-Pika', 'Local beer match, served on a sizzling plate', 299, 2,
 '[{"label":"for 2","price":299},{"label":"for 6","price":499}]', true),

-- Silogs
('Tapsilog', 'Silogs', 'Thin slices of cured beef tapa served with garlic rice and a fried egg', 399, 1, null, true),
('Fried Chicksilog', 'Silogs', 'Fried chicken served with garlic rice and a fried egg', 299, 2, null, true),
('Chicken Tosilog', 'Silogs', 'Tocino (marinated sweet chicken) served with garlic rice and a fried egg', 199, 3, null, true),
('Spamsilog', 'Silogs', 'Spam served with garlic rice and a fried egg', 199, 4, null, true),
('Hotsilog', 'Silogs', 'Hotdog sausage served with garlic rice and a fried egg', 199, 5, null, true),

-- Beverages
('Cucumber Lemonade', 'Beverages', null, 109, 1,
 '[{"label":"Glass","price":109},{"label":"Pitcher","price":309}]', true),
('Yakult Lemonade', 'Beverages', null, 129, 2,
 '[{"label":"Glass","price":129},{"label":"Pitcher","price":349}]', true),
('Honey Calamansi Juice', 'Beverages', null, 109, 3,
 '[{"label":"Glass","price":109},{"label":"Pitcher","price":309}]', true),
('Sweet Lemon Iced Tea', 'Beverages', null, 109, 4,
 '[{"label":"Glass","price":109},{"label":"Pitcher","price":309}]', true),
('Coffee', 'Beverages', 'Freshly brewed, served by the pot', 200, 5,
 '[{"label":"3–4 cups","price":200},{"label":"6–8 cups","price":300}]', true),
('Tsokolate Batirol', 'Beverages', 'Hot chocolate made from local tablea cacao and milk. Per cup', 100, 6, null, true),

-- Extras
('Plain Rice', 'Extras', null, 35, 1, null, true),
('Pancakes', 'Extras', null, 100, 2, null, true);
