// One function per event: outbox row (mock email/SMS) + assistant message in the conversation.
// Swap-in for real delivery (Resend/Twilio) lives inside this file.
import { withTenant } from "../db/client.ts";
import { messages, outbox, orders, tickets } from "../db/schema.ts";

type Order = typeof orders.$inferSelect;
type Ticket = typeof tickets.$inferSelect;

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const maskPhone = (p: string) => `***-${p.slice(-4)}`;

export async function appendAssistantText(orgId: string, conversationId: string, text: string) {
  await withTenant(orgId, (tx) => tx.insert(messages).values({
    orgId, conversationId, role: "assistant", content: [{ type: "text", text }],
  }));
}

async function deliver(orgId: string, to: { email?: string; phone: string }, subject: string, body: string, refType: string, refId: string) {
  const channel = to.email ? "email" : "sms";
  await withTenant(orgId, (tx) => tx.insert(outbox).values({
    orgId, channel, toAddr: to.email ?? to.phone, subject, body, refType, refId,
  }));
  return channel;
}

const describe = (o: Order) => {
  const a = o.snapshot.address;
  const items = o.snapshot.items.map((i) => `${i.qty} × ${i.name}`).join(", ");
  return `Items: ${items}. Ship to ${a.name}, ${a.line1}${a.line2 ? ", " + a.line2 : ""}, ${a.city} ${a.state} ${a.postalCode}. Total ${money(o.totalCents)}.`;
};

export const notify = {
  async confirmation(orgId: string, o: Order) {
    const subject = `Order #${o.number} confirmed`;
    const channel = await deliver(orgId, o.snapshot, subject,
      `Thanks for your order!\n\n${describe(o)}\n\nWe'll send tracking when it ships.`, "order", o.id);
    if (o.conversationId) await appendAssistantText(orgId, o.conversationId,
      `Order #${o.number} is confirmed. ${describe(o)} We'll ${channel === "sms" ? `text ${maskPhone(o.snapshot.phone)}` : "email you"} when it ships.`);
  },
  async rejection(orgId: string, o: Order) {
    const subject = `Order #${o.number} could not be approved`;
    const note = o.note ? ` Note from our team: ${o.note}` : "";
    await deliver(orgId, o.snapshot, subject, `We're sorry, order #${o.number} was not approved.${note}\nNo payment was taken.`, "order", o.id);
    if (o.conversationId) await appendAssistantText(orgId, o.conversationId,
      `Order #${o.number} was not approved by our team.${note} No payment was taken. I'm happy to help you adjust the order.`);
  },
  async handoff(orgId: string, t: Ticket, text: string, to: { email?: string; phone?: string }) {
    if (to.email || to.phone) await deliver(orgId, { email: to.email, phone: to.phone ?? "" }, `Reply from support (ticket #${t.id})`, text, "ticket", String(t.id));
    await appendAssistantText(orgId, t.conversationId, `[Human support agent] ${text}`);
  },
};
