# FriBee Dashboard — approved visual redesign specification

Status: APPROVED VISUAL DIRECTION; IMPLEMENTATION PENDING. This document is not a claim that the UI has been changed.

## Reference image
Owner selected the light/white dashboard image in the ChatGPT conversation on 2026-10-28 (four FriBee shirts in the hero, left pale sidebar, right AI team and activity columns). The image binary is not yet in this repository. Do not claim pixel-perfect comparison until the reference is available. Use the precise layout description below as the working specification.

## Non-negotiable brand rules
- Brand spelling **FriBee** everywhere, never Freebie.
- Use ONLY the original, owner-verified FriBee logo from brand assets/Drive. Do not use the generated bee mark from the mockup. Do not recolor, redraw, invert, or regenerate the logo without an approved variant. Provide a contrasting logo surface and never place black-on-black.
- Owner greeting **Merhaba Can,**. No invented surname, portrait or profile.
- Product art must come from verified originals; no synthetic approximations of the four shirts.
- Metrics and integration statuses must come from real data; no mockup values such as 156, 48, 98% or all-green connectors.

## Exact desktop layout
- Light theme, warm white #FBFBF9 canvas, pale gray card borders #E8E9EC, charcoal #172033 headings, muted #6E7788 descriptions, warm gold #D8A439 accent. Preserve WCAG contrast. Avoid black sidebar: owner chose the light version.
- Desktop 1536x1024 reference: sidebar ~240px wide; central work area flexible; right rail ~330px. White navigation background, compact icon + label rows with warm ivory active state, original FriBee logo in upper left.
- Header: long search field at left, notification, appearance toggle, actual local date/time, real system health at right.
- Hero central top: wide rounded ivory banner; left text 'Merhaba Can,' then 'FriBee AI Operations Studio’ya hoş geldiniz.' and concise supporting copy. Right: 4 real verified product images in collection order Space Alien black, Music white, Anime orange, Save the Bee blue. If unavailable, show deliberate neutral placeholders with labels, never invented artwork.
- Under hero: four equal KPI cards: Aktif Kampanya, Üretilen İçerik, Tamamlanan Görev, Aktif Entegrasyon. Numbers derived from DB with explicit time range; unavailable -> '—'.
- Middle row: 2/3 width İçerik Performansı line chart (real measured views/engagement/conversion, selected 7/30/90 day period) and 1/3 width Sistem Durumu card (actual web, worker, DB, integrations checks; never fabricated 98%).
- Bottom central row: Son Üretilen İçerikler cards showing verified collection thumbnails and real output status; Entegrasyonlar icon grid with provider-specific actual state.
- Right rail: AI Ajansım agent roster with factual status; Son Aktiviteler event list with timestamps and source IDs.
- Bottom full width: Brand Brain callout, but show actual ingestion coverage and link to Brand Brain, not a false 'ready' claim.
- Sidebar routes: Ana Sayfa, AI Ajansım, Kampanyalar, İçerik Üretimi, Marka Brain, Medya Arşivi, Görevler, Entegrasyonlar, Raporlar, Takvim, Ayarlar. Preserve all other existing routes through grouped navigation. No dead links.
- Use compact typography, generous but efficient spacing, rounded 12-16px cards, subtle shadows, restrained gold accents, no unnecessary gradients. Turkish copy with correct diacritics.

## Implementation
1. Audit existing Next.js design tokens, routes, components and verified brand asset lookup. Use existing component conventions and preserve data APIs.
2. Implement as actual code, not only a design description. Prefer reusable components, responsive layout, accessible chart labels, keyboard navigation, 390px mobile layout, and existing PWA behavior.
3. Provide real screenshots at desktop and mobile dimensions and compare with this specification. Do not report screenshot success if browser render not run.
4. Typecheck, build, unit, HTTP security, a11y and e2e tests. Avoid unrelated changes, paid APIs, database mutations and production deploy.
5. Commit code to this branch, update this file with actual implementation/test status, and request owner approval before merge/deploy.

## Acceptance
- Real FriBee logo visibly legible and unchanged.
- White/light design faithfully matches chosen layout.
- 'Can' greeting correct.
- No fake products, metrics, integration successes or agent statuses.
- Existing PR Agency, Brand Brain, Drive, video and task flows still work.
- Real screenshots and tests attached to PR.
