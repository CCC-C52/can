import { cookies } from "next/headers";
import { listBrands, type Brand } from "@/lib/services/brands";

export const BRAND_COOKIE = "brand_id";

/** Seçili marka (çerezden). Marka kimliği istemciden gelen form alanlarından ALINMAZ; böylece markalar arası karışma önlenir. */
export async function getCurrentBrand(): Promise<{ brand: Brand | null; brands: Brand[] }> {
  const brands = await listBrands();
  const id = (await cookies()).get(BRAND_COOKIE)?.value;
  const brand = brands.find((b) => b.id === id) ?? brands[0] ?? null;
  return { brand, brands };
}

export async function requireBrand(): Promise<Brand> {
  const { brand } = await getCurrentBrand();
  if (!brand) throw new Error("Önce bir marka oluşturun veya seçin.");
  return brand;
}

export type SP = Promise<Record<string, string | string[] | undefined>>;

export async function flash(sp: SP) {
  const p = await sp;
  const one = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  return { ok: one("ok"), err: one("err"), params: p, one };
}
