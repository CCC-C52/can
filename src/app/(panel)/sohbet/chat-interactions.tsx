"use client";

import { useEffect, useRef } from "react";

/** Keep the conversation scrolled to its newest message, not the page top. */
export function ChatMessages({ children, latestMessageId }: { children: React.ReactNode; latestMessageId: string | null }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    // Only the chat container moves; no scrollIntoView that would jump the document.
    el.scrollTop = el.scrollHeight;
  }, [latestMessageId]);
  return (
    <div ref={container} role="log" aria-label="AI Yönetici konuşması" aria-live="polite" className="card mb-4 max-h-[60vh] space-y-3 overflow-y-auto">
      {children}
    </div>
  );
}

/** Enter sends, Shift+Enter inserts a line; preserve IME composition. */
export function ChatInstructionInput() {
  return (
    <textarea
      id="instruction"
      name="instruction"
      required
      rows={4}
      maxLength={8000}
      className="input"
      placeholder="Örn: Yeni ürün için lansman hazırla…"
      aria-describedby="chat-keyboard-hint"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.repeat) return;
        event.preventDefault();
        const form = event.currentTarget.form;
        if (!form || !event.currentTarget.value.trim()) return;
        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }
        form.requestSubmit();
      }}
    />
  );
}
