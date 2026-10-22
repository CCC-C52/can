// Yerel ölçüm: her ajan için önbelleğe alınabilir önek (sistem istemi + marka bağlamı) ve değişen kısım boyutu.
// Model çağrısı yapmaz. Kullanım: node --env-file=.env --import tsx scripts/dev/measure-prompts.ts [brandId]
import { q } from "@/lib/db/pool";
import { buildBrandContext } from "@/lib/agents/context";
import { systemPrompt, userPromptParts } from "@/lib/agents/prompts";
import type { AgentId } from "@/lib/agents/schemas";

const tok = (s: string) => Math.ceil(s.length / 3.5);

async function main() {
  const brands = process.argv[2] ? [{ id: process.argv[2], name: "" }] : await q<{ id: string; name: string }>(`SELECT id, name FROM brands ORDER BY created_at`);
  for (const b of brands) {
    for (const [agent, purpose] of [["manager", "plan"], ["marketing", "work"], ["video", "work"], ["social", "work"], ["quality", "review"]] as [AgentId, string][]) {
      const ctx = await buildBrandContext(b.id, undefined, { agent });
      const sys = systemPrompt(agent, purpose);
      const { prefix, rest } = userPromptParts({ instruction: "Örnek talimat", ctx });
      console.log(`${b.name || b.id}\t${agent}:${purpose}\tsistem≈${tok(sys)}\tmarka bağlamı≈${tok(prefix)}\tönbelleklenebilir≈${tok(sys) + tok(prefix)}\tdeğişen≈${tok(rest)} token`);
    }
  }
  process.exit(0);
}
main();
