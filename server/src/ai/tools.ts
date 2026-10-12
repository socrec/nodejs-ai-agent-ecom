// All tools are built per request by makeTools(ctx): org/session/conversation come from the closure, never
// from the model. Every DB access goes through withTenant (RLS). Tools never throw: errors come back as { error }.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { and, desc, eq, gt, ilike, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type Tx, withTenant } from "../db/client.ts";
import * as s from "../db/schema.ts";
import { retrieve } from "../rag/retrieve.ts";
import { maskPhone, notify } from "./notify.ts";

export type Ctx = { orgId: string; sessionId: string; conversationId: string };
export type ToolRecord = { id: string; name: string; input: unknown; data: unknown };
type Cart = typeof s.carts.$inferSelect;
type Item = Awaited<ReturnType<typeof cartItems>>[number];

const SHIPPING_CENTS = 599;
const FREE_SHIPPING_MIN_CENTS = 5000;
export const money = (cents: number) => cents / 100;

async function openCart(tx: Tx, ctx: Ctx) {
  const find = () => tx.select().from(s.carts).where(and(eq(s.carts.sessionId, ctx.sessionId), eq(s.carts.status, "open")));
  const [cart] = await find();
  if (cart) return cart;
  // The runner executes one reply's tool calls in parallel, so two tools can race to create the cart:
  // the partial unique index (one open cart per session) + ON CONFLICT DO NOTHING makes the loser re-read.
  await tx.insert(s.carts).values({ orgId: ctx.orgId, sessionId: ctx.sessionId }).onConflictDoNothing();
  return (await find())[0]!;
}

async function cartItems(tx: Tx, cartId: string) {
  return tx.select({
    productId: s.cartItems.productId, name: s.products.name, qty: s.cartItems.qty,
    unitPriceCents: s.cartItems.unitPriceCents, stock: s.products.stock,
  }).from(s.cartItems).innerJoin(s.products, eq(s.products.id, s.cartItems.productId))
    .where(eq(s.cartItems.cartId, cartId)).orderBy(s.cartItems.productId);
}

function totals(items: Item[]) {
  const subtotalCents = items.reduce((a, i) => a + i.qty * i.unitPriceCents, 0);
  const shippingCents = items.length === 0 || subtotalCents >= FREE_SHIPPING_MIN_CENTS ? 0 : SHIPPING_CENTS;
  return { subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}

/** What the model (and the cart card) sees. Pure: totals are computed in cents, converted once for display. */
function cartView(cart: Cart, items: Item[]) {
  const { subtotalCents, shippingCents, totalCents } = totals(items);
  const address = cart.shipLine1 ? {
    name: cart.shipName, line1: cart.shipLine1, line2: cart.shipLine2 ?? undefined, city: cart.shipCity,
    state: cart.shipState, postal_code: cart.shipPostal, country: cart.shipCountry,
  } : null;
  const missing = [...(items.length ? [] : ["items"]), ...(address ? [] : ["address"]), ...(cart.phone ? [] : ["phone"])];
  return {
    items: items.map((i) => ({ product_id: i.productId, name: i.name, qty: i.qty, unit_price: money(i.unitPriceCents), line_total: money(i.qty * i.unitPriceCents) })),
    subtotal: money(subtotalCents), shipping: money(shippingCents), free_shipping_over: money(FREE_SHIPPING_MIN_CENTS), total: money(totalCents),
    address, phone: cart.phone, email: cart.email, missing, ready_to_order: missing.length === 0,
  };
}

const showCart = async (tx: Tx, cart: Cart) => cartView(cart, await cartItems(tx, cart.id));

export function makeTools(ctx: Ctx, onResult?: (r: ToolRecord) => void) {
  // Wraps run(): catches everything into { error }, records the result for SSE cards + grounding.
  const tool = <S extends z.ZodType>(name: string, description: string, inputSchema: S, fn: (input: z.infer<S>) => Promise<unknown>) =>
    betaZodTool({
      name, description, inputSchema,
      run: async (input, context) => {
        let data: unknown;
        try { data = await fn(input); } catch (e) {
          console.error(`tool ${name} failed:`, String((e as Error).message).split("\n")[0]); // first line only: no query params (PII)
          data = { error: `${name} failed; tell the customer to try again or ask for a human.` };
        }
        onResult?.({ id: context?.toolUse.id ?? "", name, input, data });
        return JSON.stringify(data);
      },
    });

  const inTenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(ctx.orgId, fn);

  return [
    tool("search_products",
      "Search this store's catalog by keywords, category or maximum price. Use it before add_to_cart to get the product_id. Returns an empty list when the store does not sell something; say so instead of inventing products.",
      z.strictObject({
        query: z.string().optional().describe("Keywords, e.g. 'salty chips'"),
        category: z.string().optional(),
        max_price: z.number().positive().optional().describe("USD"),
        in_stock_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      async (input) => {
        // ponytail: 3-char prefix stems + ILIKE; use pg_trgm/FTS when the catalog grows past a few hundred rows.
        const words = (input.query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
          .map((w) => w.slice(0, Math.max(3, w.length - 2)));
        const like = (w: string) => `%${w}%`;
        const filters = [
          ...(words.length ? [or(...words.flatMap((w) => [ilike(s.products.name, like(w)), ilike(s.products.description, like(w)), ilike(s.products.category, like(w))]))] : []),
          ...(input.category ? [ilike(s.products.category, like(input.category))] : []),
          ...(input.max_price != null ? [lte(s.products.priceCents, Math.round(input.max_price * 100))] : []),
        ];
        const rank = words.length
          ? sql<number>`${sql.join(words.map((w) => sql`(case when ${s.products.name} ilike ${like(w)} then 2 when ${s.products.description} ilike ${like(w)} or ${s.products.category} ilike ${like(w)} then 1 else 0 end)`), sql` + `)}`
          : sql<number>`0`;
        return inTenant(async (tx) => {
          const rows = await tx.select({
            product_id: s.products.id, name: s.products.name, category: s.products.category,
            priceCents: s.products.priceCents, stock: s.products.stock, description: s.products.description,
          }).from(s.products).where(and(...filters, ...(input.in_stock_only ? [gt(s.products.stock, 0)] : [])))
            .orderBy(desc(rank), s.products.id).limit(input.limit);
          // Matches hidden by in_stock_only: tell the model they exist so it says "out of stock", not "we don't sell it".
          const hidden = input.in_stock_only && filters.length
            ? await tx.select({ product_id: s.products.id, name: s.products.name }).from(s.products).where(and(...filters, eq(s.products.stock, 0))).limit(5)
            : [];
          return { products: rows.map(({ priceCents, ...r }) => ({ ...r, price: money(priceCents) })), ...(hidden.length ? { out_of_stock: hidden } : {}) };
        });
      }),

    tool("search_knowledge",
      "Semantic search over this store's policies (shipping, returns, FAQ) and product descriptions. Use it for any question about how the store works before answering. Cite the returned source.",
      z.strictObject({ query: z.string().min(2), k: z.number().int().min(1).max(6).default(4) }),
      async ({ query, k }) => {
        const results = await retrieve(ctx.orgId, query, k);
        return results.length ? { results } : { results, note: "Nothing relevant found. Say you don't know and offer a human." };
      }),

    tool("get_cart", "Show the customer's current cart, totals, saved address/phone and what is still missing before an order can be placed.",
      z.strictObject({}),
      () => inTenant(async (tx) => showCart(tx, await openCart(tx, ctx)))),

    tool("add_to_cart",
      "Set the quantity of a product in the cart (idempotent: pass the total quantity wanted, not an increment). Checks stock. Returns the updated cart.",
      z.strictObject({ product_id: z.number().int().positive(), qty: z.number().int().min(1).max(20) }),
      ({ product_id, qty }) => inTenant(async (tx) => {
        const [p] = await tx.select().from(s.products).where(eq(s.products.id, product_id));
        if (!p) return { error: `No product with id ${product_id} in this store.` };
        if (qty > p.stock) return { error: p.stock === 0 ? `${p.name} is out of stock.` : `Only ${p.stock} of ${p.name} in stock; cannot add ${qty}.` };
        const cart = await openCart(tx, ctx);
        await tx.insert(s.cartItems).values({ cartId: cart.id, orgId: ctx.orgId, productId: p.id, qty, unitPriceCents: p.priceCents })
          .onConflictDoUpdate({ target: [s.cartItems.cartId, s.cartItems.productId], set: { qty, unitPriceCents: p.priceCents } });
        return showCart(tx, cart);
      })),

    tool("remove_from_cart", "Remove a product from the cart. Returns the updated cart.",
      z.strictObject({ product_id: z.number().int().positive() }),
      ({ product_id }) => inTenant(async (tx) => {
        const cart = await openCart(tx, ctx);
        await tx.delete(s.cartItems).where(and(eq(s.cartItems.cartId, cart.id), eq(s.cartItems.productId, product_id)));
        return showCart(tx, cart);
      })),

    tool("set_shipping_address", "Save the shipping address on the cart once the customer has given it. US addresses only.",
      z.strictObject({
        name: z.string().min(2), line1: z.string().min(3), line2: z.string().optional(), city: z.string().min(2),
        state: z.string().regex(/^[A-Z]{2}$/, "two-letter state code"),
        postal_code: z.string().regex(/^\d{5}(-\d{4})?$/, "5-digit ZIP"),
        country: z.string().default("US"),
      }),
      (a) => inTenant(async (tx) => {
        const cart = await openCart(tx, ctx);
        const [updated] = await tx.update(s.carts).set({
          shipName: a.name, shipLine1: a.line1, shipLine2: a.line2 ?? null, shipCity: a.city, shipState: a.state, shipPostal: a.postal_code, shipCountry: a.country,
        }).where(eq(s.carts.id, cart.id)).returning();
        return showCart(tx, updated!);
      })),

    tool("set_contact", "Save the customer's phone number (required for every order) and optional email on the cart.",
      z.strictObject({ phone: z.string().min(7), email: z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/).optional() }),
      ({ phone, email }) => inTenant(async (tx) => {
        const normalized = phone.replace(/[\s().-]/g, "");
        if (!/^\+?\d{10,15}$/.test(normalized)) return { error: "Phone must have 10 to 15 digits, e.g. +1 415 555 0134." };
        const cart = await openCart(tx, ctx);
        const [updated] = await tx.update(s.carts).set({ phone: normalized, email: email ?? cart.email }).where(eq(s.carts.id, cart.id)).returning();
        return showCart(tx, updated!);
      })),

    tool("place_order",
      "Place the order for the current cart. Call only after the customer explicitly confirmed. Requires items, address and phone (returns an error naming what is missing). Orders over the store's threshold are held for human review and are NOT confirmed yet.",
      z.strictObject({ confirmed: z.literal(true) }),
      async () => {
        const result = await inTenant(async (tx) => {
          const cart = await openCart(tx, ctx);
          const items = await cartItems(tx, cart.id);
          const { missing } = cartView(cart, items);
          if (missing.length) return { error: `Cannot place the order yet. Missing: ${missing.join(", ")}.` };
          const short = items.filter((i) => i.qty > i.stock);
          if (short.length) return { error: `Not enough stock for ${short.map((i) => `${i.name} (${i.stock} left)`).join(", ")}.` };
          const [org] = await tx.select().from(s.orgs);
          // ponytail: max+1 order numbers; race-safe enough behind the per-session in-flight lock. Sequence per org if needed.
          const [{ last }] = await tx.select({ last: sql<number>`coalesce(max(${s.orders.number}), 1000)::int` }).from(s.orders);
          const { subtotalCents, shippingCents, totalCents } = totals(items);
          const [order] = await tx.insert(s.orders).values({
            orgId: ctx.orgId, number: last! + 1, sessionId: ctx.sessionId, cartId: cart.id, conversationId: ctx.conversationId,
            status: totalCents > org!.approvalThresholdCents ? "pending_approval" : "confirmed",
            subtotalCents, shippingCents, totalCents,
            snapshot: {
              items: items.map((i) => ({ productId: i.productId, name: i.name, qty: i.qty, unitPrice: money(i.unitPriceCents) })),
              address: { name: cart.shipName!, line1: cart.shipLine1!, line2: cart.shipLine2 ?? undefined, city: cart.shipCity!, state: cart.shipState!, postalCode: cart.shipPostal!, country: cart.shipCountry! },
              phone: cart.phone!, email: cart.email ?? undefined,
            },
          }).returning();
          // A concurrent order for the last unit trips the stock >= 0 check constraint, rolls this back and lands in { error }.
          for (const i of items) await tx.update(s.products).set({ stock: sql`${s.products.stock} - ${i.qty}` }).where(eq(s.products.id, i.productId));
          await tx.update(s.carts).set({ status: "ordered" }).where(eq(s.carts.id, cart.id));
          return { order: order! };
        });
        if ("error" in result) return result;
        const o = result.order;
        if (o.status === "confirmed") await notify.confirmation(ctx.orgId, o);
        const contact = o.snapshot.email ?? maskPhone(o.snapshot.phone);
        return {
          order_number: o.number, status: o.status, subtotal: money(o.subtotalCents), shipping: money(o.shippingCents), total: money(o.totalCents),
          items: o.snapshot.items,
          message: o.status === "confirmed"
            ? `Order confirmed. A confirmation was sent to ${contact}.`
            : `Order placed but NOT confirmed: the total is above the store's review threshold, so a human will review it. The customer will be notified here and at ${contact} once approved. Do not call it confirmed.`,
        };
      }),

    tool("get_order_status", "Look up one of this customer's orders by order number.",
      z.strictObject({ order_number: z.number().int().positive() }),
      ({ order_number }) => inTenant(async (tx) => {
        const [o] = await tx.select().from(s.orders).where(and(eq(s.orders.number, order_number), eq(s.orders.sessionId, ctx.sessionId)));
        if (!o) return { error: `No order #${order_number} for this customer.` };
        return { order_number: o.number, status: o.status, total: money(o.totalCents), items: o.snapshot.items, placed_at: o.createdAt.toISOString(), note: o.note };
      })),

    tool("escalate_to_human",
      "Hand the conversation to a human support agent: when the customer asks for a person, complains, has a payment problem, or asks for something you cannot do. Call it once; the human replies in this same chat.",
      z.strictObject({
        reason: z.enum(["wants_human", "complaint", "out_of_scope_request", "payment_issue", "other"]),
        summary: z.string().min(5).max(500).describe("One or two sentences for the support agent"),
      }),
      ({ reason, summary }) => inTenant(async (tx) => {
        const [open] = await tx.select().from(s.tickets).where(and(eq(s.tickets.conversationId, ctx.conversationId), eq(s.tickets.status, "open")));
        const ticket = open ?? (await tx.insert(s.tickets).values({ orgId: ctx.orgId, conversationId: ctx.conversationId, reason, summary }).returning())[0]!;
        await tx.update(s.conversations).set({ status: "escalated" }).where(eq(s.conversations.id, ctx.conversationId));
        return { ticket_id: ticket.id, message: "A human support agent will reply in this chat. Tell the customer to wait here; do not promise a response time." };
      })),
  ];
}
