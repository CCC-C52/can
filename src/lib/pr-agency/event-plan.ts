import type { Observance } from "./observances";

// Takvimdeki her etkinlik için PR/pazarlama planı TASLAĞI. Saf ve deterministiktir (model çağrısı yok).
// Kurallar:
//  - Var olmayan ortaklık, bağış taahhüdü, influencer anlaşması veya ölçülmemiş metrik VARSAYILMAZ.
//  - Tüm dış iletişim metinleri taslaktır; sahibin açık onayı olmadan gönderilmez (status = "draft").
//  - Bütçe bir öneridir; ücretli harcama ayrıca onay ve bütçe kapısından geçer.
//  - KPI başlangıç değerleri ölçülene kadar "unknown".

export type BrandKnowledge = {
  brandName: string;
  /** Doğrulanmış marka sesi ilkeleri (Brand Knowledge Hub). Boşsa plan bunu açıkça belirtir. */
  voice: string[];
  collections: { name: string; keywords: string[]; sourceRef: string | null }[];
  /** Doğrulanmış bağış/ortaklık taahhütleri (yoksa boş): yalnızca bunlar metinlerde anılabilir. */
  verifiedCommitments: { title: string; sourceRef: string }[];
};

/** Sağlanmayan kaynak dizinine sahip varsayılan bilgi (planlar "unknown" işaretleriyle üretilir). */
export const EMPTY_KNOWLEDGE: BrandKnowledge = { brandName: "FriBee", voice: [], collections: [], verifiedCommitments: [] };

export type Milestone = { key: string; label: string; date: string };
export type DraftMessage = { audience: "influencer" | "media"; channel: string; subject: string; body: string; status: "draft"; requiresOwnerApproval: true; guardrails: string[] };
export type Kpi = { name: string; baseline: number | "unknown"; target: string; source: string };

export type EventPlan = {
  eventId: string;
  eventName: string;
  eventDate: string;
  officialOrCommercial: "official" | "commercial" | "culture";
  themeFit: { level: "strong" | "possible" | "weak" | "unknown"; score: number; matchedCollections: string[]; rationale: string };
  leadTimeDays: number;
  milestones: Milestone[];
  approvalDeadline: string;
  creativeBrief: { objective: string; audience: string; keyMessage: string; voiceNotes: string[]; mandatories: string[]; status: "draft" };
  outreachDrafts: DraftMessage[];
  assetsNeeded: string[];
  channelPlan: { channel: string; role: string; paid: boolean; requiresApproval: boolean }[];
  budgetProposal: { currency: "USD"; low: number; high: number; split: Record<string, [number, number]>; status: "proposal_not_committed"; note: string };
  kpis: Kpi[];
  postmortem: { dueDate: string; questions: string[] };
  warnings: string[];
};

const LEAD_DAYS: Record<Observance["tier"], number> = { major: 90, standard: 45, minor: 21 };
const BUDGET: Record<Observance["tier"], [number, number]> = { major: [1500, 6000], standard: [500, 2000], minor: [0, 500] };

function shift(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Tema etiketleri ile koleksiyon anahtar kelimelerinin örtüşmesi. Marka bilgisi yoksa "unknown". */
export function scoreThemeFit(event: Pick<Observance, "themes">, knowledge: BrandKnowledge): EventPlan["themeFit"] {
  if (!knowledge.collections.length) {
    return { level: "unknown", score: 0, matchedCollections: [], rationale: "No verified collections in Brand Knowledge Hub yet — theme fit cannot be assessed." };
  }
  const themes = new Set(event.themes.map((t) => t.toLowerCase()));
  const matched: string[] = [];
  let hits = 0;
  for (const c of knowledge.collections) {
    const kw = c.keywords.map((k) => k.toLowerCase());
    const n = kw.filter((k) => themes.has(k) || [...themes].some((t) => t.includes(k) || k.includes(t))).length;
    if (n > 0) {
      matched.push(c.name);
      hits += n;
    }
  }
  const score = Math.min(1, hits / Math.max(2, event.themes.length));
  const level = score >= 0.5 ? "strong" : score > 0 ? "possible" : "weak";
  return {
    level, score: Math.round(score * 100) / 100, matchedCollections: matched,
    rationale: matched.length ? `Event themes (${event.themes.join(", ")}) overlap with: ${matched.join(", ")}.` : `No overlap between event themes (${event.themes.join(", ")}) and verified collections.`,
  };
}

export function buildEventPlan(event: Observance, knowledge: BrandKnowledge = EMPTY_KNOWLEDGE): EventPlan {
  if (!event.date) throw new Error(`${event.name}: date not verified — enter a verified date before planning.`);
  const date = event.date;
  const end = event.endDate ?? date;
  const lead = LEAD_DAYS[event.tier];
  const fit = scoreThemeFit(event, knowledge);
  const approvalDeadline = shift(date, -Math.max(7, Math.round(lead / 3)));
  const milestones: Milestone[] = [
    { key: "kickoff", label: "Strategy kickoff & theme decision", date: shift(date, -lead) },
    { key: "brief", label: "Creative brief due", date: shift(date, -Math.round(lead * 0.8)) },
    { key: "outreach", label: "Influencer/media outreach window opens (drafts only until approved)", date: shift(date, -Math.round(lead * 0.6)) },
    { key: "assets", label: "Final assets due", date: shift(date, -Math.max(10, Math.round(lead * 0.4))) },
    { key: "approval", label: "Owner approval deadline (all outbound, paid, budget)", date: approvalDeadline },
    { key: "launch", label: "Go-live", date },
    { key: "postmortem", label: "Postmortem", date: shift(end, 14) },
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const warnings: string[] = [];
  if (!knowledge.voice.length) warnings.push("Brand voice not yet defined in Brand Knowledge Hub; copy uses neutral placeholders.");
  if (fit.level === "unknown") warnings.push("Theme fit unknown: add verified collections to Brand Knowledge Hub.");
  if (event.kind === "commercial") warnings.push("Commercial opportunity — not an official holiday or observance.");
  if (event.notes) warnings.push(event.notes);

  const guardrails = [
    "Draft only — do not send without explicit owner approval.",
    "Do not imply an existing partnership, sponsorship or paid collaboration.",
    "Do not cite metrics, sales figures or reviews that are not verified.",
  ];
  if (event.causeRelated) {
    guardrails.push(
      knowledge.verifiedCommitments.length
        ? `Only reference these verified commitments: ${knowledge.verifiedCommitments.map((c) => c.title).join("; ")}.`
        : "No verified donation/partnership commitment exists — do not mention donations, proceeds or partnerships.",
    );
    warnings.push("Cause-related event: avoid performative messaging; claims require verified commitments.");
  }

  const collections = fit.matchedCollections.length ? fit.matchedCollections.join(", ") : "[collection to be selected]";
  const brand = knowledge.brandName;
  const outreachDrafts: DraftMessage[] = [
    {
      audience: "influencer", channel: "email_or_dm",
      subject: `${brand} × ${event.name}: creative idea for you`,
      body: [
        "Hi {{creator_name}},",
        `We're ${brand}, and we're planning content around ${event.name} (${date}) featuring ${collections}.`,
        "We love {{specific_recent_post}} and think there could be a natural fit. Would you be open to a short conversation about a possible collaboration?",
        "No commitment is implied by this message; terms would be agreed in writing.",
        "— {{sender_name}}, " + brand,
      ].join("\n\n"),
      status: "draft", requiresOwnerApproval: true, guardrails,
    },
    {
      audience: "media", channel: "email",
      subject: `Story idea: ${brand} and ${event.name}`,
      body: [
        "Hi {{journalist_name}},",
        `Ahead of ${event.name} on ${date}, ${brand} is preparing ${collections}. {{one_sentence_verified_story_angle}}`,
        "Happy to share imagery, product details and founder comments if useful for {{publication}}.",
        "— {{sender_name}}, " + brand,
      ].join("\n\n"),
      status: "draft", requiresOwnerApproval: true, guardrails,
    },
  ];

  const [low, high] = BUDGET[event.tier];
  const split: Record<string, [number, number]> = {
    creative_production: [Math.round(low * 0.4), Math.round(high * 0.35)],
    creator_seeding: [Math.round(low * 0.3), Math.round(high * 0.3)],
    paid_social_test: [Math.round(low * 0.2), Math.round(high * 0.25)],
    pr_tools_and_misc: [Math.round(low * 0.1), Math.round(high * 0.1)],
  };

  return {
    eventId: event.id,
    eventName: event.name,
    eventDate: date,
    officialOrCommercial: event.kind === "commercial" ? "commercial" : event.kind === "culture_event" ? "culture" : "official",
    themeFit: fit,
    leadTimeDays: lead,
    milestones,
    approvalDeadline,
    creativeBrief: {
      objective: `Build awareness and consideration for ${brand} around ${event.name}${fit.matchedCollections.length ? ` via ${collections}` : ""}.`,
      audience: "US Gen Z / millennial streetwear & culture audience (refine with measured audience data).",
      keyMessage: "{{key_message — derive from verified product story in Brand Knowledge Hub}}",
      voiceNotes: knowledge.voice.length ? knowledge.voice : ["[Brand voice not defined — add to Brand Knowledge Hub]"],
      mandatories: ["Use only approved visual assets from Brand Knowledge Hub", "Every claim must map to a verified fact", ...(event.causeRelated ? ["No donation/partnership claims without verified commitment"] : [])],
      status: "draft",
    },
    outreachDrafts,
    assetsNeeded: ["Hero image (1:1, 4:5)", "Short vertical video (9:16, 15–30s)", "Story frames (9:16)", "Email header (600px)", "Press one-pager (PDF)", "Product lookbook selection"],
    channelPlan: [
      { channel: "instagram_organic", role: "Hero content & stories", paid: false, requiresApproval: true },
      { channel: "tiktok_organic", role: "Trend-native short video", paid: false, requiresApproval: true },
      { channel: "email", role: "Owned audience announcement", paid: false, requiresApproval: true },
      { channel: "pr_outreach", role: "Media pitch (drafts above)", paid: false, requiresApproval: true },
      { channel: "creator_seeding", role: "Gifting/collab outreach (drafts above)", paid: false, requiresApproval: true },
      { channel: "paid_social", role: "Optional small test — proposal only", paid: true, requiresApproval: true },
    ],
    budgetProposal: {
      currency: "USD", low, high, split, status: "proposal_not_committed",
      note: "Range is a planning proposal, not a commitment. No paid spend occurs without owner approval and the budget gate.",
    },
    kpis: [
      { name: "Reach (owned social)", baseline: "unknown", target: "Set after baseline is measured", source: "Instagram/TikTok insights (requires connection)" },
      { name: "Engagement rate", baseline: "unknown", target: "Set after baseline is measured", source: "Instagram/TikTok insights (requires connection)" },
      { name: "Earned media mentions", baseline: "unknown", target: "Set after baseline is measured", source: "Connected news/RSS feeds" },
      { name: "Site sessions from campaign", baseline: "unknown", target: "Set after baseline is measured", source: "Shopify/analytics (requires connection)" },
      { name: "Attributed orders", baseline: "unknown", target: "Set after baseline is measured", source: "Shopify (requires connection)" },
    ],
    postmortem: {
      dueDate: shift(end, 14),
      questions: ["What did we plan vs. ship?", "Which KPIs moved vs. baseline (if measured)?", "What did it cost vs. proposal?", "Which creators/outlets responded?", "What should change next time?"],
    },
    warnings,
  };
}
