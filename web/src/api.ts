// Mock auth headers + fetch helper. Shapes mirror server/src/routes.ts (UiMessage) and ai/agent.ts (UsageSummary).
export const ORGS = [
  { id: "acme", name: "Acme Snacks" },
  { id: "blueharbor", name: "Blue Harbor Beverages" },
];

export function sessionId(): string {
  let s = localStorage.getItem("session");
  if (!s) { s = crypto.randomUUID(); localStorage.setItem("session", s); }
  return s;
}

export function headers(org: string, operator = false): Record<string, string> {
  return { "x-org-id": org, "x-session-id": sessionId(), "content-type": "application/json", ...(operator ? { "x-user-id": "operator" } : {}) };
}

export async function api<T>(org: string, path: string, init: RequestInit & { operator?: boolean } = {}): Promise<T> {
  const r = await fetch(`/api${path}`, { ...init, headers: { ...headers(org, init.operator), ...(init.headers as Record<string, string> | undefined) } });
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw Object.assign(new Error(body.error ?? r.statusText), { status: r.status, retryAfter: r.headers.get("Retry-After") });
  }
  return r.status === 204 ? (undefined as T) : r.json();
}

export type ToolCall = { id: string; name: string; input?: unknown; result?: unknown };
export type UiMessage = {
  id: number; role: "user" | "assistant"; text: string; tools: ToolCall[];
  grounding?: { ungrounded: string[] } | null; guard?: { intent: string; confidence: number } | null;
  human?: boolean; streaming?: boolean; handoff?: boolean; error?: boolean;
};
export type UsageSummary = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
export type Product = { id: number; sku: string; name: string; category: string; description: string; price: number; stock: number };
export type Conversation = { id: string; status: "active" | "escalated"; messages: UiMessage[]; pendingOrder: boolean };
