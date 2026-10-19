// Sunucu başlangıcında çalışır: internete açık (production) modda eksik güvenlik ayarlarıyla başlamayı reddeder.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionConfig } = await import("@/lib/config");
  const problems = assertProductionConfig();
  if (problems.length) {
    console.error("[web] Üretim yapılandırması eksik:\n - " + problems.join("\n - "));
    throw new Error("Üretim yapılandırması eksik; panel güvenli olmayan şekilde başlatılmayacak.");
  }
}
