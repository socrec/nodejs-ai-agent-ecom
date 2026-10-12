import { useState } from "react";
import { ORGS } from "./api.ts";
import { Operator } from "./Operator.tsx";
import { Outbox } from "./Outbox.tsx";
import { Storefront } from "./Storefront.tsx";

const TABS = ["Storefront", "Operator", "Outbox"] as const;

export function App() {
  const [org, setOrg] = useState(() => localStorage.getItem("org") ?? ORGS[0]!.id);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Storefront");
  const pick = (id: string) => { localStorage.setItem("org", id); setOrg(id); };

  return (
    <div className="mx-auto flex h-screen max-w-7xl flex-col px-4">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-3">
        <h1 className="text-lg font-semibold">Ordering Agent</h1>
        <div className="flex overflow-hidden rounded-md border border-slate-300 text-sm">
          {ORGS.map((o) => (
            <button key={o.id} onClick={() => pick(o.id)}
              className={`px-3 py-1 ${org === o.id ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-100"}`}>{o.name}</button>
          ))}
        </div>
        <nav className="ml-auto flex gap-1 text-sm">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1 ${tab === t ? "bg-slate-200 font-medium" : "hover:bg-slate-100"}`}>{t}</button>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 py-4">
        {tab === "Storefront" && <Storefront key={org} org={org} />}
        {tab === "Operator" && <Operator org={org} />}
        {tab === "Outbox" && <Outbox org={org} />}
      </main>
    </div>
  );
}
