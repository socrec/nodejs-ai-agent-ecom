// Deterministic seed: 2 stores × 12 products (two out of stock, one bundle whose 2 units cross the
// $500 approval threshold). Runs as admin, then applies rls.sql.
import { readFileSync } from "node:fs";
import { sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as s from "./schema.ts";

try { process.loadEnvFile(); } catch {}

const P = (sku: string, name: string, category: string, price: number, stock: number, description: string) =>
  ({ sku, name, category, priceCents: Math.round(price * 100), stock, description });

export const ORGS = [
  { id: "acme", name: "Acme Snacks", approvalThresholdCents: 50000 },
  { id: "blueharbor", name: "Blue Harbor Beverages", approvalThresholdCents: 50000 },
];

const PRODUCTS: Record<string, ReturnType<typeof P>[]> = {
  acme: [
    P("ACM-001", "Sea Salt Chips", "chips", 3.99, 120, "Classic kettle-cooked potato chips with a light sea salt finish. 7 oz bag, perfect for parties."),
    P("ACM-002", "BBQ Kettle Chips", "chips", 4.29, 80, "Thick-cut kettle chips dusted with smoky-sweet barbecue seasoning. 7 oz bag."),
    P("ACM-003", "Honey Roasted Peanuts", "nuts", 5.49, 60, "Crunchy peanuts glazed in honey and a pinch of salt. 12 oz resealable jar. Contains peanuts."),
    P("ACM-004", "Spicy Trail Mix", "nuts", 6.99, 45, "Almonds, cashews, chili-lime pumpkin seeds and dried mango. 14 oz bag. Contains tree nuts."),
    P("ACM-005", "Dark Chocolate Pretzels", "sweets", 5.99, 0, "Salted pretzel twists dipped in 60% dark chocolate. 10 oz bag. Currently restocking."),
    P("ACM-006", "Caramel Popcorn Tin", "sweets", 12.99, 30, "Buttery caramel popcorn in a reusable 1-gallon tin. Great as a gift."),
    P("ACM-007", "Jalapeño Cheddar Crackers", "crackers", 4.49, 70, "Baked cheddar crackers with real jalapeño. 8 oz box."),
    P("ACM-008", "Rosemary Olive Oil Crackers", "crackers", 4.99, 0, "Thin artisan crackers with rosemary and extra-virgin olive oil. 6 oz box. Currently restocking."),
    P("ACM-009", "Party Snack Crate", "bundles", 279.99, 10, "Deluxe crate of 24 full-size snacks for events of 40+ people: chips, nuts, pretzels, popcorn and jerky."),
    P("ACM-010", "Beef Jerky Original", "jerky", 8.99, 50, "Slow-smoked beef jerky, original recipe. 3 oz bag, 11 g protein per serving."),
    P("ACM-011", "Teriyaki Turkey Jerky", "jerky", 9.49, 40, "Lean turkey jerky in a sweet teriyaki marinade. 3 oz bag."),
    P("ACM-012", "Wasabi Peas", "chips", 3.49, 90, "Crunchy roasted green peas coated in hot wasabi. 6 oz bag."),
  ],
  blueharbor: [
    P("BHB-001", "Sparkling Water Lime 12-pack", "water", 6.99, 100, "Zero-calorie sparkling water with natural lime essence. Twelve 12 oz cans."),
    P("BHB-002", "Sparkling Water Grapefruit 12-pack", "water", 6.99, 85, "Crisp sparkling water with natural grapefruit essence. Twelve 12 oz cans."),
    P("BHB-003", "Cold Brew Coffee 4-pack", "coffee", 11.99, 40, "Smooth, low-acid cold brew made from Colombian beans. Four 11 oz bottles, 180 mg caffeine each."),
    P("BHB-004", "Oat Milk Latte 4-pack", "coffee", 12.99, 0, "Cold brew blended with creamy oat milk, lightly sweetened. Four 11 oz bottles. Currently restocking."),
    P("BHB-005", "Green Tea Unsweetened 6-pack", "tea", 8.49, 60, "Brewed Japanese sencha, no sugar, no additives. Six 16 oz bottles."),
    P("BHB-006", "Peach Iced Tea 6-pack", "tea", 8.99, 55, "Black tea with real peach juice. Six 16 oz bottles."),
    P("BHB-007", "Ginger Kombucha 4-pack", "kombucha", 13.99, 35, "Raw, live-cultured kombucha with fresh ginger. Four 12 oz bottles. Keep refrigerated."),
    P("BHB-008", "Berry Kombucha 4-pack", "kombucha", 13.99, 0, "Live-cultured kombucha with blueberry and raspberry. Four 12 oz bottles. Currently restocking."),
    P("BHB-009", "Electrolyte Mix 30 sticks", "sports", 24.99, 50, "Sugar-free electrolyte powder, lemon flavor. 30 single-serve sticks."),
    P("BHB-010", "Yuzu Soda 6-pack", "soda", 9.99, 45, "Japanese citrus soda made with cane sugar. Six 12 oz cans."),
    P("BHB-011", "Craft Root Beer 6-pack", "soda", 9.49, 40, "Small-batch root beer with vanilla and sassafras. Six 12 oz bottles."),
    P("BHB-012", "Office Hydration Bundle", "bundles", 289.0, 8, "Three cases of mixed sparkling water, tea and cold brew (72 drinks) for offices and events."),
  ],
};

const sql = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
const db = drizzle(sql);

await sql.unsafe(`truncate orgs, products, knowledge_chunks, carts, cart_items, orders, conversations, messages,
  message_feedback, tickets, outbox, ai_usage restart identity cascade`);
// Per-org tenant context, like withTenant(): hosted Postgres (Render) admin is only the table owner, so a
// re-seed runs under FORCE RLS.
for (const o of ORGS) await db.transaction(async (tx) => {
  await tx.execute(q`select set_config('app.org_id', ${o.id}, true)`);
  await tx.insert(s.orgs).values(o);
  await tx.insert(s.products).values(PRODUCTS[o.id]!.map((p) => ({ ...p, orgId: o.id })));
});
await sql.unsafe(readFileSync(new URL("./rls.sql", import.meta.url), "utf8"));
await sql.end();
console.log(`seeded ${ORGS.length} orgs, ${Object.values(PRODUCTS).flat().length} products; RLS applied`);
