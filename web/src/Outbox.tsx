import { useEffect, useState } from "react";
import { api } from "./api.ts";

type Item = { id: number; channel: "email" | "sms"; toAddr: string; subject: string; body: string; refType: string; createdAt: string };

export function Outbox({ org }: { org: string }) {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    const load = () => api<Item[]>(org, "/outbox").then(setItems).catch(() => {});
    load(); const t = setInterval(load, 3000); return () => clearInterval(t);
  }, [org]);
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">Mock delivery channel: every email/SMS the system would send lands here. Swap-in: Resend/Twilio inside server/src/ai/notify.ts.</p>
      {items.length === 0 && <div className="text-sm text-slate-500">Nothing sent yet.</div>}
      {items.map((m) => (
        <div key={m.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className={`rounded px-1.5 py-0.5 ${m.channel === "email" ? "bg-blue-100 text-blue-800" : "bg-green-100 text-green-800"}`}>{m.channel}</span>
            <span>to {m.toAddr}</span><span>· {m.refType}</span><span className="ml-auto">{new Date(m.createdAt).toLocaleString()}</span>
          </div>
          <div className="mt-1 font-medium">{m.subject}</div>
          <pre className="mt-1 whitespace-pre-wrap font-sans text-xs text-slate-700">{m.body}</pre>
        </div>
      ))}
    </div>
  );
}
