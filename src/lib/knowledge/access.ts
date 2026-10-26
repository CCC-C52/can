import type { AgentId } from "@/lib/agents/schemas";
import { PermissionDeniedError, type KnowledgeRole, type Sensitivity } from "./types";

// Rol bazlı erişim: her ajan rolü yalnızca izin verilen hassasiyetteki kayıtları görür.
// "private" (sözleşme, ortaklık, kişisel kayıt) hiçbir ajana otomatik verilmez; yalnızca sahip görür.

export const ROLE_ACCESS: Record<KnowledgeRole, readonly Sensitivity[]> = {
  manager: ["public", "internal", "vendor"],
  video_design: ["public", "internal"],
  marketing: ["public", "internal"],
  pr: ["public", "internal"],
  finance: ["public", "internal", "vendor", "finance"],
};

export const ROLE_LABELS: Record<KnowledgeRole, string> = {
  manager: "AI Yönetici",
  video_design: "Video / Tasarım",
  marketing: "Shopify / Pazarlama",
  pr: "PR Ajansı",
  finance: "Finans",
};

/** Mevcut ajan kimliklerinin bilgi rollerine eşlemesi (PR ve Finans ajanları henüz yok). */
export function roleForAgent(agent: AgentId): KnowledgeRole {
  switch (agent) {
    case "manager":
    case "quality": return "manager";
    case "design":
    case "video": return "video_design";
    default: return "marketing";
  }
}

export function canRead(role: KnowledgeRole, s: Sensitivity) {
  return ROLE_ACCESS[role].includes(s);
}

export function assertCanRead(role: KnowledgeRole, s: Sensitivity) {
  if (!canRead(role, s)) throw new PermissionDeniedError(`${ROLE_LABELS[role]} rolü "${s}" kayıtlarını göremez.`);
}
