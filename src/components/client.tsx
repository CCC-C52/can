"use client";
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";

export function SubmitButton({ children, className = "btn-primary", pendingText = "İşleniyor…", confirm, disabled }: { children: React.ReactNode; className?: string; pendingText?: string; confirm?: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={pending || disabled}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? pendingText : children}
    </button>
  );
}

/** Aktif iş varken sayfayı belirli aralıklarla yeniler (sunucu bileşenleri yeniden okunur). */
export function AutoRefresh({ active, intervalMs = 3000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  if (!active) return null;
  return <span className="inline-flex items-center gap-1 text-xs text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-info" />Canlı güncelleniyor</span>;
}

/** Her form gösteriminde benzersiz istek anahtarı üretir (çift gönderimi önler). */
export function IdempotencyField({ name = "idempotencyKey" }: { name?: string }) {
  const [k] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`));
  return <input type="hidden" name={name} value={k} />;
}
