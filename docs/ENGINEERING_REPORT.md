# AI Operations Studio — Engineering Report

Date: 2026-10-21 · Branch: `claude/amazing-goodall-qkxupd` · Baseline: `a6b009d` (code that was live on Render before this work) · Report covers commits `cbb79a2` … HEAD.

Status labels used (only these): **PASS** · **PASS WITH LIMITATION** · **BLOCKED** · **NOT IMPLEMENTED** · **NOT TESTED**.
"Verified" below means: exercised by an automated test or a recorded manual run **in this development environment** (local PostgreSQL 16, local filesystem and an S3-compatible test server, real ffmpeg/sharp, Chromium). Nothing here was verified on Render, against the production database, against real FriBee records, or against a real AI/commerce provider.

---

## 0. Read first — deployment control issue

`render.yaml` (from the earlier deployment preparation) makes Render track **this same branch**, and it did not set an auto-deploy option, so Render's default (deploy on every commit) applies. The directive says the app runs on "existing Render infrastructure". During this work, ten commits (`cbb79a2` … `c3299d5`) were pushed to that branch before I identified this.

- **If Auto-Deploy is on for `aiops-web` / `aiops-worker`, those commits may already have been deployed to production**, and `preDeployCommand: npm run db:migrate` would have applied migration `002_media_jobs_integrity.sql` to the production database. That migration only adds tables, columns, indexes, `NOT VALID` constraints and triggers. It also re-labels existing derived media rows (`origin 'edited'` → `'composed'` for agent-composed photos) and fills `generation_method` / `project_id`. It deletes nothing. Even so, it is a production schema/data change that the directive says requires separate authorization.
- I have **no Render access** and could not check. After identifying the issue I stopped pushing: the last commits (Render auto-deploy off, ffmpeg memory limits, documentation and this report) are **committed locally only, not pushed**.
- **Owner action:** Render → `aiops-web` → **Events**. If deploys from 2026-10-21 appear, decide whether to keep them or **Rollback** (§26). Then set **Settings → Auto-Deploy = Off** on both services and **Blueprint → Auto Sync = Off**, and tell me whether to push the remaining local commits.

---

## 1. Executive summary

The reported production failure (`Marketing Specialist cannot use outputs.read`) was reproduced in a test and fixed by correcting agent permissions. Agent context is now limited to what each agent is permitted to read.

The platform now has:
- real image understanding (pixels) and real video understanding (frames, scenes, motion, audio);
- resumable multipart uploads up to 2 GB;
- the full set of marketing deliverables;
- locally rendered image compositions (carousel, story, banner, reel cover, typography, logo) as real files;
- an ffmpeg editor with transitions, intro/outro cards, subtitles and thumbnails, and validated output;
- AI image (OpenAI) and AI video (Google Veo) integrations with persistent, idempotent provider jobs and an owner-controlled paid-generation switch;
- reject → revise → approve with immutable history;
- a diagnostics screen, structured logs and request IDs;
- HTTP-level security tests against a production build;
- an accessibility scan;
- a 24-step acceptance workflow.

Two real bugs were found by the new tests and fixed:
- A worker that lost its lease could still write a duplicate output version.
- Brand names in Turkish made English copy fail the language check.

What is **not** verified:
- any live provider call (no credentials or paid-test authorization);
- the workflow on real FriBee data (no access);
- the Docker image build and anything on Render.

Video editing needs more memory than the current 512 MB worker plan.

---

## 2. Original audit findings

Full audit (Turkish): [`AUDIT.md`](AUDIT.md). Summary of the baseline `a6b009d`:

| Area | Baseline |
|---|---|
| Agent permissions | **Broken** — marketing lacked `outputs.read`; agent context ignored `products.read`/`media.read` |
| Image / video understanding | **Missing** — only filename, dimensions, one dominant colour, ffprobe metadata |
| Uploads | **Broken for large files** — whole file buffered in web process memory, no progress or resume |
| Compositions | Partial — one post layout |
| Video editing | Partial — trim/concat/subtitles; no transitions, cards, thumbnail or output validation |
| AI image | Unverified — generation only, no reference image, no owner spend switch |
| AI video | **Missing** — interface only; OpenAI Sora/Videos API was shut down 2026-09-24 |
| Approvals | Partial — no reject→revise step; history mutable at DB level |
| Monitoring | Missing — health endpoint only, unstructured logs |
| Security tests | Service-level only; no HTTP/route-level cross-brand tests |
| Tests | 33 |

## 3. Root causes

| Issue | Root cause | Class |
|---|---|---|
| `outputs.read` failure | `runGenerate()` asserts `outputs.read` whenever a task has upstream outputs; marketing's tool list did not include it. The DEMO planner never gave marketing a dependency, so tests never hit it; the real Claude manager did. | code |
| Agents saw data beyond their permissions | `buildBrandContext()` returned all products/media to every agent | code |
| Large uploads failing | `request.formData()` + `arrayBuffer()` in the web process (512 MB instance) | code |
| Stale-worker duplicate versions (found by new test) | Output/version writes were not tied to lease ownership; only the final status update was | code |
| English copy rejected for Turkish-named brand (found by acceptance test) | Language detection counted proper nouns (brand/product names) | code |
| Video edit memory | ffmpeg default threading per input × 5 inputs at 1080×1920 | code + infrastructure |
| Possible unapproved deploys | Blueprint tracks the development branch with default auto-deploy | configuration |

## 4. Files changed

`a6b009d..HEAD`: 100+ files, ~6,000 insertions (42 added, 1 removed: `src/lib/services/tagging.ts`, replaced by media analysis). Main new modules:

- `src/lib/media-analysis/` — pixel analysis, video analysis, analysis queue/cache.
- `src/lib/uploads/`, `src/app/api/uploads/**`, `src/components/uploader.tsx` — multipart, resumable uploads.
- `src/lib/orchestrator/render.ts` — design/video rendering, provider job flow.
- `src/lib/services/provider-jobs.ts` — persistent provider jobs.
- `src/lib/services/diagnostics.ts`, `src/app/(panel)/tanilama`, `src/app/api/diagnostics`.
- `src/lib/log.ts`, `src/lib/ids.ts`, `src/lib/security/rate-limit.ts`, `src/lib/db/check.ts`.
- `migrations/002_media_jobs_integrity.sql`.
- Tests: `tests/*.test.ts` (15 files), `tests/http/security.ts`, `tests/http/a11y.ts`, `scripts/acceptance/workflow.ts`, `tests/live/live.ts`.
- Docs: `docs/AUDIT.md`, `docs/OPERATIONS.md`, `docs/ENGINEERING_REPORT.md`, updated `README.md`, `docs/DEPLOY.md`.

## 5. Features repaired

| Feature | Status |
|---|---|
| Marketing (and every specialist) can read upstream outputs when the plan gives it a dependency; full 7×6 permission matrix tested | **PASS** |
| Least-privilege agent context (products/media only when permitted) | **PASS** |
| Upload of large files (multipart, streamed, resumable) | **PASS WITH LIMITATION** — largest real file tested 46.6 MB in the browser; multi-GB not tested; R2 not tested (S3-compatible test server only) |
| Failure visibility: failure class + recommended action on task, project, report; `blocked` / `needs_input` project states | **PASS** |
| Worker that lost its lease cannot write results | **PASS** |
| Language check ignores brand/product names | **PASS** |
| Media file serving streams with byte ranges (no full read into memory) | **PASS** |
| Malformed IDs → 404 (previously could produce 500) | **PASS** |
| Login redirect rejects `/\host` style open redirects | **PASS** |

## 6. New features implemented

| Feature | Status |
|---|---|
| Manager clarifying questions (`questions_for_owner` → "Bilgi bekliyor") | **PASS** |
| Marketing deliverables: brand analysis, competitor framework (no invented competitors), organic strategy, performance recommendations, assumptions, PDP drafts, carousel/story briefs, Reels ideas, TikTok concepts, 7-day calendar | **PASS WITH LIMITATION** — schema, UI, QA rules and DEMO content verified; quality of real-model output not tested |
| Local compositions: post, carousel (N slides + page indicator), story, banner, reel cover, typography mode, logo overlay; 1:1, 4:5, 9:16, 16:9 | **PASS** |
| ffmpeg editing: segment selection, fit/fill, cut/xfade, intro/outro cards, bottom subtitles + top on-screen text in safe zones, thumbnail, validation | **PASS** |
| AI image generation (OpenAI Images, text and real-photo reference via `/images/edits`) | **PASS WITH LIMITATION** (mocked) · live **BLOCKED** |
| AI video generation (Google Veo via Gemini API) | **PASS WITH LIMITATION** (mocked) · live **BLOCKED** |
| Persistent provider jobs: idempotent per version+item, reconciliation after restart, `unknown` for interrupted submissions, owner "resubmit" | **PASS** |
| Owner switch for paid media generation (default off) and per-project video-seconds cap | **PASS** |
| Reject → revise (note becomes specialist feedback) → approve | **PASS** |
| Diagnostics screen and `/api/diagnostics` | **PASS** |
| Structured JSON logs with redaction; `X-Request-Id` | **PASS** |
| Vision-on-upload setting; cost per service on output page | **PASS** |
| 24-step acceptance workflow + CLI for an authorized copy | **PASS** on isolated fixture · real FriBee **BLOCKED** |
| Opt-in live test suite | **NOT TESTED** (implemented; guards verified to refuse) |
| Accessibility (axe WCAG 2.1 A/AA, desktop + phone) | **PASS WITH LIMITATION** — automated scan only; no manual screen-reader test |

## 7. Database migrations

`002_media_jobs_integrity.sql` (additive, idempotent):

- **New tables:** `media_analyses`, `upload_sessions`, `provider_jobs`.
- **New columns:**
  - `tasks`: `failure_class`, `progress`.
  - `projects`: `questions`.
  - `media_assets`: `project_id`, `generation_method`, `alt_text`.
  - `cost_entries`: `provider_job_id`, `analysis_id`.
- **Indexes** on previously unindexed foreign keys.
- **Constraints:** `NOT VALID` checks for task status, approval decision and media origin. Existing rows are not re-checked.
- **Triggers:** approvals are append-only (only `revoked_at` may be set once); output version content is immutable.
- **Backfill:** existing derived media are labelled `composed`, `ffmpeg_edit` or `ai_image` and linked to their project.

Tests:
- applied to a clean database and re-run with no changes;
- applied to a database fixture at 001 with data, where row counts and relations are preserved and the triggers are enforced;
- `npm run db:check` (read-only integrity check) is clean.

Production execution: **NOT TESTED** by me, and possibly already applied by auto-deploy (§0).

## 8. Environment variables

New:
- `GEMINI_API_KEY`, `VEO_MODEL`, `VEO_COST_PER_SECOND_USD`
- `UPLOAD_DIRECT`
- `FFMPEG_THREADS`
- `LOG_LEVEL`
- `MAX_UPLOAD_MB` (default raised to 2048)
- tests only: `TEST_S3_ENDPOINT`; `LIVE_*`; `ACCEPTANCE_CONFIRM_COPY`; `A11Y_BASE`, `A11Y_PASSWORD`; `HTTP_TEST_PORT`

Owner-supplied in production:
- **required:** `ADMIN_PASSWORD`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `BACKUP_S3_BUCKET`
- **for real AI:** `AIOPS_ANTHROPIC_API_KEY`
- **optional:** `OPENAI_API_KEY` + `OPENAI_IMAGE_COST_USD`; `GEMINI_API_KEY` + `VEO_COST_PER_SECOND_USD`; Shopify/Instagram keys

Render generates `SESSION_SECRET` and `ENCRYPTION_KEY`. No secret values appear in the repository. Full table: [`OPERATIONS.md` §2](OPERATIONS.md#2-ortam-değişkenleri).

## 9. Provider integrations

| Provider | Endpoint / behaviour | Verification | Status |
|---|---|---|---|
| Anthropic (text + vision) | Messages streaming, structured outputs, adaptive thinking, server-side fallbacks; images as base64 blocks | Mocked SSE (request shape, image blocks, cost, errors) | **PASS WITH LIMITATION** (live not tested here; the reported production error implies live planning reached specialist execution) |
| OpenAI Images | `POST /v1/images/generations`; `POST /v1/images/edits` multipart with `image[]`, `input_fidelity=high` | Mocked fetch (exact URL, form fields); engine flow with fake generator | **PASS WITH LIMITATION** · live **BLOCKED** (credentials, authorization) |
| Google Veo | `POST /v1beta/models/{model}:predictLongRunning` (`x-goog-api-key`), poll `GET /v1beta/{operation}`, download with key only on the Google API host, redirects followed manually | Mocked fetch (body, header, redirect key isolation, size cap, filter/failed states); engine flow across a worker restart | **PASS WITH LIMITATION** · live **BLOCKED** |
| OpenAI Sora / Videos API | Shut down 2026-09-24 | — | **NOT IMPLEMENTED** (by decision) |
| Shopify, Instagram | Unchanged in this work | Mocked (earlier tests) | **PASS WITH LIMITATION** |
| TikTok auto-publish, Meta Ads | — | — | **NOT IMPLEMENTED** (manual TikTok package exists) |

API details were checked against official documentation through web search; the docs sites themselves are blocked by this environment's network policy.

## 10. Agent permission changes

- **manager:** + `media.read`
- **marketing:** + `media.read`, `outputs.read`
- **shopify:** + `media.read`
- **social:** + `media.read`
- **design, video, quality:** unchanged

`buildBrandContext(..., {agent})` now omits products and media for agents without `products.read` / `media.read`. The media context includes compact analysis results and alt text. Tests:
- the regression reproduces the live plan shape (`analysis → strategy`);
- every specialist works downstream of every other specialist;
- no agent holds an unrestricted/admin tool;
- a permission failure is recorded as class `permission`, dependants are cancelled and the project shows "blocked", never "completed";
- the manager's clarifying questions put the project in "needs input";
- context filtering.

## 11. Media analysis improvements

- **Images:**
  - dimensions after EXIF rotation, orientation, aspect;
  - brightness, contrast, Laplacian sharpness, colourfulness;
  - dominant colours named via Lab nearest match;
  - background uniformity and quality flags;
  - optional vision-model description, tags, product visibility and alt text, sent as real pixels (≤1568 px JPEG), never the filename.
- **Video:**
  - probe (rotation-aware) and scene cuts;
  - up to 6 keyframes stored per analysis;
  - per-frame colours, brightness and sharpness;
  - motion measured excluding pairs that cross a cut;
  - audio presence and loudness;
  - usability score and recommendations;
  - optional vision analysis of labelled frames.
- **Pipeline:** analyses are cached by `sha(asset sha : version : level : model)` and not reprocessed. They run on a leased worker queue, results are shown on the media page, and they are fed to agents.

Tests use known-content fixtures (colours, sharp vs blurred, colour-scene video, panning video). Status: local analysis **PASS**; vision analysis **PASS WITH LIMITATION** (mocked model).

## 12. Upload improvements

- **Transfer:** 8 MiB parts, 3 in parallel, per-part retry with backoff, real byte progress.
- **States:** Preparing / Uploading / Verifying / Processing / Done / Failed / Cancelled.
- **Resume:** reselecting the same file sends only the missing parts.
- **Verification:** server-side type sniffing from bytes, exact part-size enforcement, SHA-256 dedupe, crash-safe verification.
- **Housekeeping:** 24 h expiry; rate limits per brand.
- **Direct-to-bucket mode:** presigned parts (`UPLOAD_DIRECT=true`) are **NOT TESTED** and need bucket CORS.

Tests cover:
- local and S3 multipart;
- interruption and resume;
- duplicates and fake content;
- size, type, part and brand limits.

## 13. Image generation improvements

- Reference-image generation from the brand's real product photo.
- Output must decode, be ≥256 px and not be uniform, otherwise it is not counted. A blank placeholder fails the item.
- One provider job per version and brief: retries and redelivery never call the provider twice. An ambiguous response becomes `unknown` and blocks the project until the owner decides.
- Estimated and actual cost are linked to the job.
- AI images are tagged "not a real product photo".

## 14. Video generation improvements

- **New Veo provider:** submit, persisted operation, re-queued polling (does not consume attempts, ~30 min cap), immediate download, ffprobe validation, archive, thumbnail.
- **Image-to-video:** the first frame comes from a real product photo when one is selected.
- **Limits:** per-project seconds cap; the cost estimate needs a configured price per second.
- **Restart behaviour:** a worker restart resumes polling; an interrupted submission is marked `unknown` by the worker reconciler.

## 15. Approval improvements

- Reject with a note optionally sends the note to the specialist as revision feedback.
- Old versions and decisions are kept; approvals are append-only and version content is immutable (DB triggers).
- An old version cannot be approved after a revision.
- Output page shows: cost per service, AI provider jobs (status, cost, polls, "resubmit" with an explicit confirmation), and failure class with recommended action.

## 16. Security improvements

- Request IDs.
- Structured logs with secret-key redaction (including Google keys, Bearer tokens, signed URL parameters).
- UUID validation before the database.
- Streaming file responses with `nosniff` and sandbox CSP.
- Open-redirect hardening.
- ffmpeg/ffprobe restricted to `file,pipe` protocols with argument arrays.
- Provider keys sent only to their own API host.
- Paid generation off by default.
- Brand checks on analysis frames, provider jobs, uploads and exports.

**HTTP security suite** (production build, `APP_MODE=production`, S3 storage) — 34 checks:
- unauthenticated access to pages and APIs; forged session cookie;
- health endpoint returns no data; security headers;
- wrong password; cookie flags (`__Host-`, HttpOnly, Secure, SameSite=Lax);
- cross-brand access to media, analysis frames, upload sessions (status/targets/parts/complete/abort), exports, and output/task/project/media pages;
- list pages do not leak another brand's IDs;
- tampered server-action form with another brand's version ID;
- CSRF origin check; path-traversal and SQL-shaped IDs;
- no secrets in diagnostics; DEMO off in production;
- no secret names or values in client bundles;
- login lockout.

## 17. Deployment changes

- `render.yaml`:
  - `autoDeployTrigger: "off"` on web and worker (local commit, not pushed; see §0);
  - worker plan unchanged (Starter) with a documented recommendation.
- Measured memory (5-segment 1080×1920 edit with transitions): ffmpeg peak 715 MB before, 440 MB after the thread/lookahead limits, plus ~145 MB for Node. **A Starter worker (512 MB) is insufficient for video editing.** Standard (2 GB) is $25/month; total ≈ $39.50/month ([Render pricing](https://render.com/pricing)).
- Worker additionally runs the upload-verification queue, the analysis queue and the provider-job reconciler.
- Dockerfile unchanged (ffmpeg, DejaVu fonts and the PostgreSQL 17 client already present).
- Docs: deployment checklist, 14-point post-deploy verification and rollback in [`OPERATIONS.md` §11–12](OPERATIONS.md#11-dağıtım); [`DEPLOY.md`](DEPLOY.md) updated.

## 18. Tests executed

| Suite | Command | Scope |
|---|---|---|
| Unit + integration + e2e | `TEST_S3_ENDPOINT=… npm test` | 15 files: acceptance (24 steps), agent-permissions, anthropic-adapter, integrations, jobs (timeout, permanent error, concurrent claim, stale worker, reject/revise), launch-flow, media-analysis, migrations, production, provider-adapters, qa-language, render (compositions, AI image/video flows, ffmpeg), safety, schema-compat, uploads |
| HTTP security | `npm run build && npm run test:http` | §16 |
| Accessibility | `npm run test:a11y` | 16 pages + 4 detail pages × desktop/phone |
| Type check / build | `npm run typecheck`, `npm run build` | — |
| Manual | Browser runs | 46.6 MB video upload; demo launch flow; previews; diagnostics; subtitle placement frames inspected visually |

## 19. Test results

| Suite | Result |
|---|---|
| `npm test` with S3 test server | **85 / 85 passed** |
| `npm test` without S3 | 83 passed, 2 skipped (S3-only) |
| `npm run test:http` | **34 / 34 passed** |
| `npm run test:a11y` | **0 violations** (after fixing: chat contrast, colour-only links, unlabelled selects, non-focusable scroll regions) |
| `tsc --noEmit`, `next build` | pass |
| `npm run test:live` | **not run** — guards verified to refuse without authorization |
| Docker image build | **NOT TESTED** — `apt` inside `docker build` is blocked in this environment |

## 20. FriBee acceptance-test results

| Run | Result |
|---|---|
| 24 steps on an **isolated fixture brand** (clearly named as synthetic; generated product photo and video) | **PASS** — 24/24, with real files: decoded compositions, an h264 MP4, real keyframes, an approval history with rejection and revision, and cross-brand denial |
| 24 steps on **real FriBee data** | **BLOCKED** — no access to production data or an authorized copy from this environment. Run `ACCEPTANCE_CONFIRM_COPY=yes npm run acceptance -- --brand <fribee-slug>` against an authorized copy; it adds a new project and never modifies existing records |
| Live AI image/video generation for FriBee | **BLOCKED** — credentials and paid-test authorization |

## 21. Mocked versus live verification

| Capability | Mocked / local | Live |
|---|---|---|
| Text model (Anthropic) | PASS (mock SSE) | NOT TESTED here |
| Vision analysis | PASS (mock model; real pixels sent) | NOT TESTED |
| AI image (OpenAI) | PASS (mock fetch + fake generator) | BLOCKED |
| AI video (Veo) | PASS (mock fetch + fake generator) | BLOCKED |
| Object storage | PASS (local + S3-compatible test server) | NOT TESTED on R2 |
| Shopify / Instagram | PASS (mock) | NOT TESTED |
| Compositions, ffmpeg, pixel/frame analysis | PASS (real, local) | n/a (no provider) |

No mocked result is reported as live anywhere in the code, tests or docs. The live suite writes results labelled `LIVE`.

## 22. Known limitations

- DEMO outputs are templates (local mode only; disabled in production).
- Content-language QA covers English and Turkish only.
- AI images cannot be automatically verified to preserve product details. They are flagged and require human review.
- Veo output is 4–8 s, 720p, 9:16 or 16:9 per clip; longer videos would need stitching (not implemented).
- Audio is removed in edits (licensing is a manual decision); no music/voice-over mixing.
- Direct browser-to-bucket uploads are untested and off by default.
- Verifying a 2 GB upload needs up to 2 GB of temporary disk on the worker. Render's ephemeral disk capacity was not verified.
- Single owner account; no roles.
- Brand selection is a cookie: an owner-only boundary, not a multi-tenant security boundary.
- Accessibility verified by automated scan only.
- Costs are estimates or provider-reported usage × price; not reconciled with invoices.

## 23. Remaining blockers

| Item | What is missing | Why | Cause | Action | Blocks deployment? |
|---|---|---|---|---|---|
| Unknown production state | Whether commits auto-deployed and migration 002 ran | No Render access | configuration | Owner checks Render Events (§0) | Yes — must be resolved before any further deploy |
| Video editing on Render | Enough worker memory | 512 MB < ~590 MB measured | infrastructure / product decision | Upgrade worker to Standard, or accept image-only use | No for text/images; yes for video |
| FriBee acceptance on real data | Authorized copy of FriBee data | No access | infrastructure / authorization | Provide a copy environment, run the acceptance CLI | No |
| Live AI image/video tests | Keys, unit prices, paid-test authorization | Not provided | credentials / authorization | Set keys and prices, authorize, run `npm run test:live` | No (features stay off until enabled) |
| Docker image build | Build verification | Network policy blocks apt in Docker here | infrastructure | First Render build is the verification; watch the build log | Possibly — a failed build keeps the previous version running |
| Render post-deploy verification | 14-point check | Not deployed by me | authorization | After approval, follow `OPERATIONS.md` §11 | — |

## 24. Required owner actions

1. Check Render Events for deploys since 2026-10-21; keep them or roll back (§26). Turn **Auto-Deploy Off** on both services and **Blueprint Auto Sync Off**.
2. Tell me whether to push the local commits (auto-deploy off in `render.yaml`, ffmpeg memory limits, docs, this report).
3. Decide the worker plan: Starter (no reliable video editing) or Standard (+$18/month, total ≈ $39.50).
4. Approve (or not) a production deployment and the migration-002 execution if it has not already happened.
5. Optionally provide an authorized copy of FriBee data for the 24-step acceptance run.
6. Optionally add AI image/video keys and unit prices in Render, then explicitly authorize one paid live test per provider (budget cap, e.g. $2).
7. Keep the Anthropic console spending limit in place; set per-task and daily budgets in Settings.

## 25. Operational cost considerations

| Item | Monthly |
|---|---|
| Web (Starter) | $7 |
| Worker — Starter / **Standard (recommended for video)** | $7 / **$25** |
| Postgres Basic-256mb + 5 GB disk | $7.50 |
| Cloudflare R2 (≤10 GB free; then $0.015/GB) | ~$0 |
| **Total** | **$21.50 / $39.50** |

Not included: Anthropic usage (bounded by app budgets and the console limit). Optional OpenAI image and Veo video usage is off by default, needs owner permission and is bounded by budgets and the per-project video-seconds cap. Prices from [render.com/pricing](https://render.com/pricing), checked October 2026.

## 26. Rollback plan

- **Code:** Render → service → Events → previous successful deploy → **Rollback** (web and worker). Migration 002 is additive, so the previous code runs on the new schema. The approval trigger only forbids edits and deletes that the previous code never performs.
- **Data:** pause all operations → Render Postgres **Recovery** (PITR) to a time before the deploy → switch `DATABASE_URL`. Alternatively `RESTORE_CONFIRM=evet npm run db:restore -- latest` from the R2 dump.
- **Media:** `RESTORE_CONFIRM=evet npm run db:restore -- media`.
- **Paid generation:** Settings → turn off paid AI media generation; revoke keys at the provider.

Details: [`OPERATIONS.md` §12](OPERATIONS.md#12-geri-alma).

## 27. Production readiness assessment

| Area | Status |
|---|---|
| Architecture integration, no fabricated outputs, no hardcoded secrets, build/typecheck/tests | **PASS** |
| Agent orchestration (delegation, permissions, dependencies, visible failures, bounded retries, isolation) | **PASS WITH LIMITATION** — verified with DEMO/scripted models, not live Claude in this environment |
| Media understanding | **PASS WITH LIMITATION** — local analysis verified; vision model mocked |
| Media handling (upload, recovery, durable storage, state accuracy, access) | **PASS WITH LIMITATION** — S3-compatible test server, not R2; ≤46.6 MB tested |
| Content production (copy, compositions, edited video, linkage to tasks/approvals) | **PASS WITH LIMITATION** — Render worker memory for video (§23) |
| Existing FriBee product assets usable | **BLOCKED** — no access to FriBee data |
| AI generation (integrations, error handling, credential reporting, paid controls) | **PASS WITH LIMITATION** — mocked; live **BLOCKED** |
| Approval system (preview, download, approve, reject, revise, history, nothing auto-published) | **PASS** |
| Security (authentication, authorization, isolation, private media, secrets, security tests) | **PASS** (local production build) |
| Reliability (job recovery, provider failure visibility, restarts, monitoring, documented deploy/rollback) | **PASS** |
| Docker build and Render deployment | **NOT TESTED** |
| Production deployment | **NOT TESTED** — not performed or verified by me; possibly triggered by auto-deploy (§0) |

**Assessment:** ready for owner review, **not** for an unattended production release. Before any release:
1. resolve §0;
2. decide the worker plan;
3. approve the deploy and migration;
4. run the 14-point post-deploy verification.

I have stopped before production deployment, as instructed.
