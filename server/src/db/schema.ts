import { sql } from "drizzle-orm";
import {
  check, doublePrecision, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, uniqueIndex, uuid, vector,
} from "drizzle-orm/pg-core";

const orgId = () => text("org_id").notNull().references(() => orgs.id);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  approvalThresholdCents: integer("approval_threshold_cents").notNull().default(50000),
});

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  orgId: orgId(),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull(),
  priceCents: integer("price_cents").notNull(),
  stock: integer("stock").notNull(),
}, (t) => [uniqueIndex("products_org_sku").on(t.orgId, t.sku), check("products_stock_nonneg", sql`${t.stock} >= 0`)]); // no oversell under concurrent place_order

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: serial("id").primaryKey(),
  orgId: orgId(),
  source: text("source").notNull(),
  heading: text("heading").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 384 }).notNull(),
});

export const carts = pgTable("carts", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  sessionId: text("session_id").notNull(),
  status: text("status").notNull().default("open"), // open | ordered
  shipName: text("ship_name"),
  shipLine1: text("ship_line1"),
  shipLine2: text("ship_line2"),
  shipCity: text("ship_city"),
  shipState: text("ship_state"),
  shipPostal: text("ship_postal"),
  shipCountry: text("ship_country"),
  phone: text("phone"),
  email: text("email"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("carts_one_open").on(t.orgId, t.sessionId).where(sql`status = 'open'`)]);

export const cartItems = pgTable("cart_items", {
  cartId: uuid("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
  orgId: orgId(),
  productId: integer("product_id").notNull().references(() => products.id),
  qty: integer("qty").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
}, (t) => [primaryKey({ columns: [t.cartId, t.productId] })]);

export type OrderSnapshot = {
  items: { productId: number; name: string; qty: number; unitPrice: number }[];
  address: { name: string; line1: string; line2?: string; city: string; state: string; postalCode: string; country: string };
  phone: string;
  email?: string;
};

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  number: integer("number").notNull(),
  sessionId: text("session_id").notNull(),
  cartId: uuid("cart_id").notNull().references(() => carts.id),
  conversationId: uuid("conversation_id"),
  status: text("status").notNull(), // pending_approval | confirmed | rejected
  subtotalCents: integer("subtotal_cents").notNull(),
  shippingCents: integer("shipping_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
  snapshot: jsonb("snapshot").$type<OrderSnapshot>().notNull(),
  createdAt: createdAt(),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  note: text("note"),
}, (t) => [uniqueIndex("orders_org_number").on(t.orgId, t.number)]);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  sessionId: text("session_id").notNull(),
  status: text("status").notNull().default("active"), // active | escalated
  createdAt: createdAt(),
}, (t) => [index("conversations_org_session").on(t.orgId, t.sessionId)]);

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(), // serial doubles as stable ordering within a turn
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  orgId: orgId(),
  role: text("role").notNull(), // user | assistant
  content: jsonb("content").notNull(), // raw Claude content: string or content block array
  grounding: jsonb("grounding").$type<{ ungrounded: string[] }>(),
  guard: jsonb("guard").$type<{ intent: string; confidence: number }>(),
  createdAt: createdAt(),
}, (t) => [index("messages_conversation").on(t.conversationId)]);

export const messageFeedback = pgTable("message_feedback", {
  messageId: integer("message_id").primaryKey().references(() => messages.id),
  orgId: orgId(),
  rating: text("rating").notNull(), // up | down
  note: text("note"),
});

export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  orgId: orgId(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  reason: text("reason").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull().default("open"), // open | resolved
  createdAt: createdAt(),
});

export const outbox = pgTable("outbox", {
  id: serial("id").primaryKey(),
  orgId: orgId(),
  channel: text("channel").notNull(), // email | sms
  toAddr: text("to_addr").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  refType: text("ref_type").notNull(), // order | ticket
  refId: text("ref_id").notNull(),
  createdAt: createdAt(),
});

export const aiUsage = pgTable("ai_usage", {
  id: serial("id").primaryKey(),
  orgId: orgId(),
  feature: text("feature").notNull(), // chat | guard | summary | eval
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  ungroundedNumbers: integer("ungrounded_numbers").notNull().default(0),
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("ai_usage_org_created").on(t.orgId, t.createdAt)]);
