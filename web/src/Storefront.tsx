import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { type Product, type ToolCall, type UiMessage, api } from "./api.ts";
import { useChatStream } from "./useChatStream.ts";

const usd = (n: number) => `$${n.toFixed(2)}`;
const TONES: Record<string, string> = {
  slate: "bg-slate-100 text-slate-800", green: "bg-green-100 text-green-800", amber: "bg-amber-100 text-amber-800",
  blue: "bg-blue-100 text-blue-800", purple: "bg-purple-100 text-purple-800", yellow: "bg-yellow-100 text-yellow-800",
};
const Badge = ({ tone = "slate", children }: { tone?: string; children: React.ReactNode }) => (
  <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${TONES[tone]}`}>{children}</span>
);

/** Cards render from tool JSON only — never parsed from prose. */
function ToolCard({ t }: { t: ToolCall }) {
  const r = t.result as any;
  if (!r) return null;
  if (r.error) return <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{t.name}: {r.error}</div>;
  if (t.name === "search_products") return (
    <div className="grid gap-2 sm:grid-cols-2">
      {r.products.length === 0 && <div className="text-xs text-slate-500">No matching products in this store.</div>}
      {r.products.map((p: any) => (
        <div key={p.product_id} className="rounded border border-slate-200 bg-white p-2 text-sm">
          <div className="flex justify-between gap-2"><span className="font-medium">{p.name}</span><span>{usd(p.price)}</span></div>
          <div className="text-xs text-slate-500">#{p.product_id} · {p.category} · {p.stock > 0 ? `${p.stock} in stock` : "out of stock"}</div>
          <div className="mt-1 text-xs text-slate-600">{p.description}</div>
        </div>
      ))}
    </div>
  );
  if (["get_cart", "add_to_cart", "remove_from_cart", "set_shipping_address", "set_contact"].includes(t.name)) return (
    <div className="rounded border border-slate-200 bg-white p-2 text-sm">
      <div className="mb-1 flex items-center gap-2 font-medium">Cart {r.ready_to_order ? <Badge tone="green">ready to order</Badge> : r.missing?.map((m: string) => <Badge key={m} tone="amber">needs {m}</Badge>)}</div>
      {r.items.length === 0 ? <div className="text-xs text-slate-500">Empty</div> : (
        <table className="w-full text-xs"><tbody>
          {r.items.map((i: any) => <tr key={i.product_id}><td>{i.qty} × {i.name}</td><td className="text-right">{usd(i.line_total)}</td></tr>)}
          <tr className="border-t border-slate-200"><td>Subtotal</td><td className="text-right">{usd(r.subtotal)}</td></tr>
          <tr><td>Shipping</td><td className="text-right">{r.shipping === 0 ? "free" : usd(r.shipping)}</td></tr>
          <tr className="font-medium"><td>Total</td><td className="text-right">{usd(r.total)}</td></tr>
        </tbody></table>
      )}
      {r.address && <div className="mt-1 text-xs text-slate-600">Ship to {r.address.name}, {r.address.line1}, {r.address.city} {r.address.state} {r.address.postal_code}</div>}
      {r.phone && <div className="text-xs text-slate-600">Phone ***-{String(r.phone).slice(-4)}</div>}
    </div>
  );
  if (t.name === "place_order") return (
    <div className="rounded border border-slate-200 bg-white p-2 text-sm">
      <div className="flex items-center gap-2 font-medium">Order #{r.order_number} {r.status === "confirmed" ? <Badge tone="green">confirmed</Badge> : <Badge tone="amber">pending approval</Badge>}</div>
      <div className="text-xs text-slate-600">{r.items.map((i: any) => `${i.qty} × ${i.name}`).join(", ")} · total {usd(r.total)}</div>
    </div>
  );
  if (t.name === "search_knowledge") return (
    <div className="flex flex-wrap gap-1">
      {r.results.length === 0 && <Badge>no relevant policy found</Badge>}
      {r.results.map((c: any, i: number) => <Badge key={i} tone="blue">{c.source} › {c.heading} · {c.score}</Badge>)}
    </div>
  );
  if (t.name === "escalate_to_human") return <Badge tone="purple">ticket #{r.ticket_id} opened</Badge>;
  if (t.name === "get_order_status") return <div className="text-xs">Order #{r.order_number}: <Badge>{r.status}</Badge> · {usd(r.total)}</div>;
  return null;
}

function Bubble({ m, org }: { m: UiMessage; org: string }) {
  const [rated, setRated] = useState<string | null>(null);
  const rate = async (rating: "up" | "down") => { setRated(rating); await api(org, `/messages/${m.id}/feedback`, { method: "POST", body: JSON.stringify({ rating }) }).catch(() => {}); };
  if (m.role === "user") return (
    <div className="ml-auto max-w-[80%]">
      <div className="rounded-2xl rounded-br-sm bg-slate-900 px-3 py-2 text-sm text-white whitespace-pre-wrap">{m.text}</div>
      {m.guard && <div className="mt-0.5 text-right"><Badge tone={["off_topic", "abuse", "prompt_injection"].includes(m.guard.intent) ? "amber" : "slate"}>guard: {m.guard.intent}</Badge></div>}
    </div>
  );
  return (
    <div className="max-w-[90%] space-y-2">
      {m.tools.length > 0 && <div className="flex flex-wrap gap-1">{m.tools.map((t) => <Badge key={t.id} tone={t.result ? "slate" : "yellow"}>⚙ {t.name}</Badge>)}</div>}
      {m.tools.map((t) => <ToolCard key={t.id} t={t} />)}
      {(m.text || m.streaming) && (
        <div className={`rounded-2xl rounded-bl-sm px-3 py-2 text-sm ${m.human ? "border border-purple-200 bg-purple-50" : m.error ? "bg-red-50 text-red-800" : m.handoff ? "bg-amber-50" : "bg-white border border-slate-200"}`}>
          {m.human && <div className="mb-1 text-xs font-medium text-purple-700">Human support agent</div>}
          <div className="[&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1"><Markdown>{m.human ? m.text.replace(/^\[Human support agent\]\s*/, "") : m.text || (m.streaming ? "…" : "")}</Markdown></div>
        </div>
      )}
      {!m.streaming && m.id > 0 && !m.human && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {m.grounding && (m.grounding.ungrounded.length === 0
            ? <Badge tone="green">✓ numbers grounded</Badge>
            : <Badge tone="amber">⚠ ungrounded: {m.grounding.ungrounded.join(", ")}</Badge>)}
          <button onClick={() => rate("up")} className={rated === "up" ? "text-green-700" : "hover:text-slate-900"}>👍</button>
          <button onClick={() => rate("down")} className={rated === "down" ? "text-red-700" : "hover:text-slate-900"}>👎</button>
        </div>
      )}
    </div>
  );
}

export function Storefront({ org }: { org: string }) {
  const chat = useChatStream(org);
  const [input, setInput] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [usage, setUsage] = useState<any>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => { api<Product[]>(org, "/products").then(setProducts).catch(() => setProducts([])); }, [org]);
  useEffect(() => { api(org, "/usage").then(setUsage).catch(() => {}); }, [org, chat.tick]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [chat.messages]);

  const submit = (e: React.FormEvent) => { e.preventDefault(); const t = input.trim(); if (!t) return; setInput(""); chat.send(t); };
  const cacheRate = usage?.totals?.calls ? Math.round(100 * usage.totals.cacheReadTokens / Math.max(1, usage.totals.inputTokens + usage.totals.cacheReadTokens)) : 0;

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[1fr_300px]">
      <section className="relative flex min-h-0 flex-col rounded-lg border border-slate-200 bg-slate-100/60">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs text-slate-600">
          <span>Session {localStorage.getItem("session")?.slice(0, 8)}</span>
          {chat.status === "escalated" && <Badge tone="purple">waiting for a human agent…</Badge>}
          {chat.pendingOrder && <Badge tone="amber">order awaiting approval…</Badge>}
          <button onClick={chat.reset} className="ml-auto rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-50">New conversation</button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          {chat.messages.length === 0 && <div className="text-sm text-slate-500">Try: “I need something salty for a party, 2 bags” · “What's your return window?” · “I want to talk to a person”</div>}
          {chat.messages.map((m, i) => <Bubble key={m.id > 0 ? m.id : `tmp-${i}`} m={m} org={org} />)}
          <div ref={bottom} />
        </div>
        <form onSubmit={submit} className="flex gap-2 border-t border-slate-200 p-3">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={chat.busy ? "Thinking…" : "Message the store…"} maxLength={2000}
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500" />
          <button disabled={chat.busy || !input.trim()} className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40">Send</button>
        </form>
        {chat.toast && <div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg">{chat.toast}</div>}
      </section>
      <aside className="flex min-h-0 flex-col gap-3 text-sm">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-1 font-medium">Usage (this store)</div>
          {usage?.totals ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-slate-600">
              <span>calls</span><span className="text-right">{usage.totals.calls}</span>
              <span>tokens in / out</span><span className="text-right">{usage.totals.inputTokens + usage.totals.cacheReadTokens} / {usage.totals.outputTokens}</span>
              <span>cache hit</span><span className="text-right">{cacheRate}%</span>
              <span>cost</span><span className="text-right">${usage.totals.costUsd.toFixed(4)}</span>
              <span>ungrounded numbers</span><span className="text-right">{usage.totals.ungrounded}</span>
              {usage.byFeature.map((f: any) => <span key={f.feature} className="col-span-2 flex justify-between border-t border-slate-100 pt-0.5"><span>{f.feature} · {f.calls} calls</span><span>${f.costUsd.toFixed(4)}</span></span>)}
              {chat.usage && <span className="col-span-2 border-t border-slate-100 pt-0.5">last turn: {chat.usage.calls} calls · {chat.usage.input + chat.usage.cacheRead}/{chat.usage.output} tok · ${chat.usage.costUsd.toFixed(4)}</span>}
            </div>
          ) : <div className="text-xs text-slate-500">No calls yet.</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-1 font-medium">Catalog</div>
          <ul className="space-y-1 text-xs">
            {products.map((p) => (
              <li key={p.id} className="flex justify-between gap-2 border-b border-slate-100 py-1">
                <span className={p.stock === 0 ? "text-slate-400 line-through" : ""}>{p.name}</span>
                <span className="whitespace-nowrap text-slate-600">{usd(p.price)}{p.stock === 0 && " · out"}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
