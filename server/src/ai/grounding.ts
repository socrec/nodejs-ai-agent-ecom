// Output guardrail: every number in the model's answer must appear in a tool input/result this conversation.
// ponytail: regex heuristic (tolerant to $12.99 / 12.99 / 1,299 and digit runs inside phones/zips); not a fact checker.
const NUM = /\$?\d[\d,]*(?:\.\d+)?/g;
const norm = (s: string) => Number(s.replace(/[$,]/g, ""));
const digits = (s: string) => s.replace(/\D/g, "");

export function verifyNumbers(text: string, toolData: unknown[]): { ungrounded: string[] } {
  const corpus = JSON.stringify(toolData).match(NUM) ?? [];
  const values = new Set(corpus.map(norm));
  const runs = corpus.map(digits);
  const cleaned = text.replace(/^\s*\d+\.\s/gm, ""); // markdown list markers
  const ungrounded = [...new Set(cleaned.match(NUM) ?? [])].filter((m) => {
    if (values.has(norm(m))) return false;
    const d = digits(m);
    return !(d.length >= 3 && runs.some((r) => r.includes(d)));
  });
  return { ungrounded };
}
