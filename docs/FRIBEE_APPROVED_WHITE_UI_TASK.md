# FriBee HQ — approved white dashboard redesign

## Owner-approved visual specification (28 Oct 2026)
Implement this in the existing Next.js app. This is the exact design direction selected by Can: bright white / warm off-white main canvas, subtle gold accents, very light gray card borders, spacious rounded dashboard cards, left sidebar in very pale off-white (not dark), compact top search/navigation, right-hand AI Agency and Recent Activity rail. Keep layout visually faithful to the owner's approved dashboard screenshot in the ChatGPT conversation. The screenshot is a **visual reference only**, not a source of business facts or official brand assets.

### Brand and personalization — mandatory
- Official spelling **FriBee**. Use only the **existing authentic FriBee logo** from verified brand media/Drive/repository. Do not draw or invent a bee logo, replace the wordmark, or change its proportions.
- The original logo must contrast with its background; never place black artwork on a black/dark surface. Use an approved existing variant or a light container. If no verified original asset exists, use the plain wordmark text "FriBee" and flag asset missing.
- Welcome heading **"Merhaba Can,"**, account display **"Can"**. Do not show "Fikret", "Fikret Bey", or invented user portraits.
- Show actual verified product photos for Space Alien (black), Music (white), Anime (orange), Save the Bee (light blue). Do not use the mockup's fabricated garment images or modify official artwork. If verified imagery unavailable, use tasteful empty states.

### Desktop layout
1. Left fixed 220–240px sidebar on white/off-white with official logo lockup at top; gold active navigation indicator, simple line icons, muted labels. Sections: Ana Sayfa, AI Ajansım, Kampanyalar, İçerik Üretimi, Marka Brain/Brand Brain, Medya Arşivi, Görevler, Entegrasyonlar, Raporlar, Takvim, Ayarlar. Preserve all existing routes and add appropriate grouping for remaining current features, with no dead links.
2. Topbar: wide search, notifications, system health, accurate date/time, user Can.
3. Main hero: large rounded cream/white editorial banner, welcome text left, authentic FriBee collection photography on right only if verified.
4. Four KPI cards: Aktif Kampanya, Üretilen İçerik, Tamamlanan Görev, Aktif Entegrasyon. Real DB-derived counts only, correct timeframe, empty states otherwise.
5. Mid row: wide İçerik Performansı chart (real metrics only), smaller Sistem Durumu card (real health checks only).
6. Bottom row: Son Üretilen İçerikler with genuine media thumbnails and links; Entegrasyonlar grid showing real per-provider connection state.
7. Right rail: AI Ajansım roster with true task/worker state and Son Aktiviteler from actual event records.
8. Bottom CTA: Brand Brain, linking to existing real knowledge module. No fake upgrade/paywall/premium claims.

### Style system
- Primary background #FAFBFC or near-white; card white; gentle cream #FFF8ED for hero/active surfaces; text deep charcoal #182236; secondary text muted slate; gold accent #D8A440 used sparingly.
- 12–18px card corner radius, hairline gray borders, restrained shadows, 8px spacing grid, accessible contrast, modern editorial headings and compact UI body typography.
- Professional polished white SaaS, no dark theme for this chosen design, no heavy black sidebar, no neon.
- Responsive: desktop multi-column, tablet compressed cards, mobile single-column with usable nav, existing PWA preserved.
- No invented "all integrations active", fake 98% system uptime, fabricated analytics, fake tasks, dates, employee avatars, video production successes or paid plan claims.

### Implementation and safety
- Inspect current code and latest branch changes before editing; reuse existing design tokens and routes. Scope is UI; do not rewrite agent orchestration, media pipeline, PR logic or migrations unnecessarily.
- Source original logo from verified assets, not the mockup. Never alter authentic logo/artwork. Avoid shipping copyrighted font files outside approved license.
- Add screenshot-based desktop/mobile visual review, navigation tests, accessible contrast, no horizontal overflow; npm run typecheck, npm run build, relevant tests.
- Make a code PR for review. **Do not deploy to production without separate owner approval.** No paid API calls.
- Report screenshot locations, actual changes, tests, missing authentic assets, and any unverified integrations.

## Definition of done
The application visually matches the owner's approved white dashboard concept, greets **Can**, uses the **real FriBee identity**, shows only truthful data, and preserves all operational functionality.
