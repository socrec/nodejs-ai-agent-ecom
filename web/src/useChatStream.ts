// POST /api/chat via fetch + ReadableStream (SSE needs POST, so no EventSource). Polls the conversation
// every 3 s while escalated or an order awaits approval so human/notification messages show up.
import { useCallback, useEffect, useState } from "react";
import { type Conversation, type UiMessage, type UsageSummary, api, headers } from "./api.ts";

type Ev = { type: string } & Record<string, any>;

export function useChatStream(org: string) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [status, setStatus] = useState<"active" | "escalated">("active");
  const [pendingOrder, setPendingOrder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [tick, setTick] = useState(0); // bumps after every turn so the usage strip refetches

  const reset = useCallback(() => {
    localStorage.removeItem(`conv:${org}`);
    setConversationId(null); setMessages([]); setStatus("active"); setPendingOrder(false); setUsage(null);
  }, [org]);

  const load = useCallback(async (id: string) => {
    try {
      const c = await api<Conversation>(org, `/conversations/${id}`);
      setMessages(c.messages); setStatus(c.status); setPendingOrder(c.pendingOrder);
    } catch { reset(); }
  }, [org, reset]);

  useEffect(() => {
    const id = localStorage.getItem(`conv:${org}`);
    if (id) { setConversationId(id); load(id); }
  }, [org, load]);

  useEffect(() => {
    if (!conversationId || busy || (status !== "escalated" && !pendingOrder)) return;
    const t = setInterval(() => load(conversationId), 3000);
    return () => clearInterval(t);
  }, [conversationId, status, pendingOrder, busy, load]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);

  const patchLast = (fn: (m: UiMessage) => void) => setMessages((ms) => {
    const copy = ms.slice(); const last = { ...copy[copy.length - 1]!, tools: copy[copy.length - 1]!.tools.slice() }; fn(last); copy[copy.length - 1] = last; return copy;
  });

  const handle = (ev: Ev) => {
    switch (ev.type) {
      case "meta": setConversationId(ev.conversationId); localStorage.setItem(`conv:${org}`, ev.conversationId); break;
      case "guard": setMessages((ms) => { const copy = ms.slice(); const u = copy[copy.length - 2]; if (u?.role === "user") copy[copy.length - 2] = { ...u, guard: { intent: ev.intent, confidence: ev.confidence } }; return copy; }); break;
      case "text_delta": patchLast((m) => { m.text += ev.text; }); break;
      case "tool_call": patchLast((m) => { m.tools.push({ id: ev.id, name: ev.name }); }); break;
      case "tool_result": patchLast((m) => { const t = m.tools.find((x) => x.id === ev.id); if (t) { t.input = ev.input; t.result = ev.data; } else m.tools.push({ id: ev.id, name: ev.name, input: ev.input, result: ev.data }); }); break;
      case "handoff": patchLast((m) => { m.text = ev.message; m.handoff = true; }); break;
      case "done": patchLast((m) => { m.id = ev.messageId; m.grounding = ev.grounding; m.streaming = false; }); setStatus(ev.status); setPendingOrder(ev.pendingOrder); setUsage(ev.usage); break;
      case "error": patchLast((m) => { m.text = ev.error; m.error = true; m.streaming = false; }); setToast(ev.error); break;
    }
  };

  const send = async (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setMessages((ms) => [...ms, { id: -Date.now(), role: "user", text, tools: [] }, { id: 0, role: "assistant", text: "", tools: [], streaming: true }]);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: headers(org), body: JSON.stringify({ conversationId, message: text }) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; retryAfter?: number };
        const retry = res.headers.get("Retry-After");
        setToast(res.status === 429 ? `${body.error ?? "Rate limited."} Retry in ${retry ?? body.retryAfter}s.` : body.error ?? `Error ${res.status}`);
        setMessages((ms) => ms.slice(0, -2));
        return;
      }
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const lines = frame.split("\n");
          const type = lines.find((l) => l.startsWith("event: "))?.slice(7);
          const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
          if (type && data) handle({ ...JSON.parse(data), type });
        }
      }
    } catch (e) {
      setToast((e as Error).message);
      patchLast((m) => { m.text ||= "Connection lost."; m.error = true; m.streaming = false; });
    } finally { setBusy(false); setTick((t) => t + 1); }
  };

  return { messages, send, busy, status, pendingOrder, toast, usage, tick, reset };
}
