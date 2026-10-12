// Embedding seam: swap this function for Voyage/OpenAI in prod. MiniLM runs locally, 384-d, no API key.
import { pipeline } from "@huggingface/transformers";

let extractor: ReturnType<typeof pipeline<"feature-extraction">> | undefined;

export async function embed(texts: string[]): Promise<number[][]> {
  extractor ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "fp32" });
  const out = await (await extractor)(texts, { pooling: "mean", normalize: true });
  return out.tolist() as number[][];
}
