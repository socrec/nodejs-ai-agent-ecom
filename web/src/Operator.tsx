import { useEffect, useState } from "react";
import { type UiMessage, api } from "./api.ts";

type Ticket = { id: number; reason: string; summary: string; createdAt: string; messages: UiMessage[] };
type Order = { id: string; number: number; total: number; createdAt: string; phone: string; email?: string; items: { qty: number; name: string }[]; address: { name: string; line1: string; city: string; state: string; postalCode: string } };

export function Operator({ org }: { org: string }) {
  const [queue, setQueue] = useState<{ tickets: Ticket[]; orders: Order[] }>({ tickets: [], orders: [] });
  const [reply, setReply] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => api<typeof queue>(org, "/operator/queue", { operator: true }).then(setQueue).catch((e) => setErr(e.message));
  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [org]);

  const act = (path: string, body?: unknown) => api(org, path, { method: "POST", operator: true, body: JSON.stringify(body ?? {}) }).then(refresh).catch((e) => setErr(e.message));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {err && <div className="col-span-full rounded bg-red-50 p-2 text-sm text-red-800">{err}</div>}
      <section>
        <h2 className="mb-2 font-medium">Pending orders <span className="text-slate-500">({queue.orders.length})</span></h2>
        {queue.orders.length === 0 && <div className="text-sm text-slate-500">Nothing to approve.</div>}
        <div className="space-y-2">
          {queue.orders.map((o) => (
            <div key={o.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <div className="flex items-baseline justify-between"><span className="font-medium">Order #{o.number}</span><span className="font-medium">${o.total.toFixed(2)}</span></div>
              <div className="text-xs text-slate-600">{o.items.map((i) => `${i.qty} × ${i.name}`).join(", ")}</div>
              <div className="text-xs text-slate-600">{o.address.name}, {o.address.line1}, {o.address.city} {o.address.state} {o.address.postalCode} · {o.phone}{o.email ? ` · ${o.email}` : ""}</div>
              <div className="mt-2 flex gap-2">
                <button onClick={() => act(`/operator/orders/${o.id}/approve`)} className="rounded bg-green-700 px-3 py-1 text-xs text-white">Approve</button>
                <button onClick={() => act(`/operator/orders/${o.id}/reject`, { note: "Please contact us to verify this order." })} className="rounded bg-red-700 px-3 py-1 text-xs text-white">Reject</button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-medium">Open tickets <span className="text-slate-500">({queue.tickets.length})</span></h2>
        {queue.tickets.length === 0 && <div className="text-sm text-slate-500">No open tickets.</div>}
        <div className="space-y-2">
          {queue.tickets.map((t) => (
            <div key={t.id} className="rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm">
              <div className="flex items-baseline justify-between"><span className="font-medium">Ticket #{t.id} · {t.reason}</span><span className="text-xs text-slate-500">{new Date(t.createdAt).toLocaleTimeString()}</span></div>
              <div className="text-xs text-slate-700">{t.summary}</div>
              <div className="mt-2 space-y-1 rounded bg-white/70 p-2 text-xs">
                {t.messages.map((m) => <div key={m.id}><span className="font-medium">{m.role === "user" ? "Customer" : m.human ? "Agent" : "Assistant"}:</span> {m.text.slice(0, 240)}</div>)}
              </div>
              <div className="mt-2 flex gap-2">
                <input value={reply[t.id] ?? ""} onChange={(e) => setReply({ ...reply, [t.id]: e.target.value })} placeholder="Reply to the customer…"
                  className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs" />
                <button disabled={!reply[t.id]?.trim()} onClick={() => act(`/operator/tickets/${t.id}/reply`, { text: reply[t.id] }).then(() => setReply({ ...reply, [t.id]: "" }))}
                  className="rounded bg-purple-700 px-3 py-1 text-xs text-white disabled:opacity-40">Send</button>
                <button onClick={() => act(`/operator/tickets/${t.id}/resolve`)} className="rounded border border-slate-300 bg-white px-3 py-1 text-xs">Resolve</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
