export type Chunk = { source: string; heading: string; content: string };

/** Split markdown on #/## headings, then accumulate paragraphs up to ~max chars. Policy clauses stay whole. */
export function chunk(markdown: string, source: string, max = 800): Chunk[] {
  const out: Chunk[] = [];
  let heading = source;
  for (const block of markdown.split(/\n(?=#{1,2} )/)) {
    const m = block.match(/^#{1,2} (.+)\n?([\s\S]*)$/);
    if (m) heading = m[1]!.trim();
    const body = (m ? m[2]! : block).trim();
    let buf = "";
    // ponytail: a single paragraph longer than `max` stays one chunk; split on sentences if docs grow.
    for (const para of body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
      if (buf && buf.length + para.length > max) { out.push({ source, heading, content: buf }); buf = ""; }
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    if (buf) out.push({ source, heading, content: buf });
  }
  return out;
}
