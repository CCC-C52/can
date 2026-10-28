// Profesyonel PR bilgi kütüphanesi — başlangıç kayıtları (saf veri).
// Özetler bu uygulama için kendi sözlerimizle yazılmış kısa açıklamalardır; kaynak metinler kopyalanmaz (telif).
// "verification":
//   verified            — yayın bilgisi (yazar, yıl, DOI veya yayıncı) bu sürüm hazırlanırken bağımsız kaynaklarla doğrulandı
//   partially_verified  — sürüm/yıl doğrulandı, ayrıntılı içerik resmî kaynaktan ayrıca kontrol edilmeli
//   needs_review        — yerleşik literatür referansı; bu sürümde yeniden doğrulanmadı
// checkedAt: kontrol tarihi.

export type LibrarySeed = {
  slug: string;
  category: string;
  title: string;
  summary: string;
  application: string;
  sourceTitle: string;
  sourceUrl: string | null;
  sourceRef: string | null;
  publisher: string;
  version: string | null;
  publishedYear: number | null;
  verification: "verified" | "partially_verified" | "needs_review";
  verifiedNote: string;
};

export const LIBRARY_CHECKED_AT = "2026-10-28";

export const LIBRARY_SEED: LibrarySeed[] = [
  {
    slug: "amec-integrated-evaluation-framework", category: "Measurement & evaluation",
    title: "AMEC Integrated Evaluation Framework (IEF)",
    summary: "A logic-model approach to communication evaluation that links organisational objectives to inputs, activities, outputs, out-takes, outcomes and organisational impact. It separates what was produced (outputs) from how audiences responded (out-takes) and what changed (outcomes, impact).",
    application: "Every FriBee campaign report is structured by IEF stage. Impressions and advertising-value equivalents are never reported as impact. Missing stages are reported as data gaps, not estimated.",
    sourceTitle: "AMEC — Integrated Evaluation Framework", sourceUrl: "https://amecorg.com/amecframework/", sourceRef: null,
    publisher: "International Association for the Measurement and Evaluation of Communication (AMEC)", version: "Launched 2016", publishedYear: 2016,
    verification: "partially_verified", verifiedNote: "Stage names and 2016 launch confirmed in multiple independent sources; check amecorg.com for any later revision.",
  },
  {
    slug: "barcelona-principles-4", category: "Measurement & evaluation",
    title: "Barcelona Principles 4.0",
    summary: "AMEC's statement of good practice for communication measurement, revised roughly every five years since 2010. Version 4.0 (2025) presents seven principles ordered along the stages of the Integrated Evaluation Framework, from goal setting to impact.",
    application: "Goals are set before activity; outcomes and impact are measured, not just outputs; methods are transparent; vanity metrics are not used as proof of value.",
    sourceTitle: "AMEC — Barcelona Principles 4.0", sourceUrl: "https://amecorg.com/", sourceRef: null,
    publisher: "AMEC", version: "4.0", publishedYear: 2025,
    verification: "partially_verified", verifiedNote: "Version 4.0 and its 2025 launch at the AMEC Summit (Vienna) confirmed via independent sources; principle wording to be checked against AMEC's official text before quoting.",
  },
  {
    slug: "stp-segmentation-targeting-positioning", category: "Marketing strategy",
    title: "STP — Segmentation, Targeting, Positioning",
    summary: "Divide the market into meaningful segments, choose the segments to serve, and define a distinct position in the minds of those customers relative to alternatives.",
    application: "Brand Strategy uses STP to state who each FriBee collection is for and why it is different. Segments are described from research evidence, never from invented customer data.",
    sourceTitle: "Kotler, P. & Keller, K. L. — Marketing Management", sourceUrl: null, sourceRef: "Pearson (multiple editions)",
    publisher: "Pearson", version: null, publishedYear: null,
    verification: "needs_review", verifiedNote: "Established textbook framework; edition not re-verified in this release.",
  },
  {
    slug: "keller-cbbe", category: "Brand equity",
    title: "Customer-Based Brand Equity (Keller)",
    summary: "Brand equity is the differential effect that brand knowledge (awareness and image) has on how customers respond to the brand's marketing. Strong, favourable and unique associations build equity.",
    application: "Annual and quarterly reviews track awareness and association strength only from measured sources (surveys, search interest, earned share of voice).",
    sourceTitle: "Keller, K. L. (1993). Conceptualizing, Measuring, and Managing Customer-Based Brand Equity. Journal of Marketing, 57(1), 1–22.",
    sourceUrl: "https://doi.org/10.1177/002224299305700101", sourceRef: "DOI 10.1177/002224299305700101",
    publisher: "Journal of Marketing (American Marketing Association / SAGE)", version: null, publishedYear: 1993,
    verification: "verified", verifiedNote: "Citation and DOI confirmed via publisher (SAGE) record.",
  },
  {
    slug: "integrated-marketing-communications", category: "Communications planning",
    title: "Integrated Marketing Communications (IMC)",
    summary: "Plan all brand communications — advertising, PR, social, retail, direct — as one coordinated programme with a consistent message and measurable objectives.",
    application: "The PR Director aligns campaign, social, creator and press drafts to one approved message house per campaign.",
    sourceTitle: "Schultz, D. E., Tannenbaum, S. I. & Lauterborn, R. F. — Integrated Marketing Communications", sourceUrl: null, sourceRef: "NTC Business Books, 1993",
    publisher: "NTC Business Books", version: null, publishedYear: 1993,
    verification: "needs_review", verifiedNote: "Established literature reference; not re-verified in this release.",
  },
  {
    slug: "consumer-behavior", category: "Consumer insight",
    title: "Consumer behaviour fundamentals",
    summary: "How people recognise needs, search, evaluate, buy and use products, and how identity, culture and social influence shape those choices.",
    application: "Market Intelligence frames research questions (who, why, where they discover streetwear) before collecting evidence.",
    sourceTitle: "Solomon, M. R. — Consumer Behavior: Buying, Having, and Being", sourceUrl: null, sourceRef: "Pearson (multiple editions)",
    publisher: "Pearson", version: null, publishedYear: null,
    verification: "needs_review", verifiedNote: "Established textbook; edition not re-verified in this release.",
  },
  {
    slug: "fashion-marketing", category: "Fashion marketing",
    title: "Fashion marketing and product drops",
    summary: "Fashion marketing combines seasonal and drop calendars, product storytelling, visual merchandising and community to build desirability without discounting the brand.",
    application: "Campaign calendars follow collection drops; product artwork and colours are never altered in marketing material.",
    sourceTitle: "Posner, H. — Marketing Fashion: Strategy, Branding and Promotion", sourceUrl: null, sourceRef: "Laurence King Publishing",
    publisher: "Laurence King Publishing", version: null, publishedYear: null,
    verification: "needs_review", verifiedNote: "Literature reference; edition not re-verified in this release.",
  },
  {
    slug: "cultural-branding", category: "Cultural branding",
    title: "Cultural branding (identity myths)",
    summary: "Brands can become cultural icons when their stories address tensions in society and give consumers meaningful identity myths, rather than only communicating product benefits.",
    application: "Creative Director and Brand Strategy explore the cultural territories of each collection; claims about culture are research-backed and respectful.",
    sourceTitle: "Holt, D. B. — How Brands Become Icons: The Principles of Cultural Branding", sourceUrl: null, sourceRef: "Harvard Business School Press, 2004",
    publisher: "Harvard Business School Press", version: null, publishedYear: 2004,
    verification: "needs_review", verifiedNote: "Literature reference; not re-verified in this release.",
  },
  {
    slug: "reputation-management", category: "Reputation",
    title: "Corporate reputation management",
    summary: "Reputation is the collective assessment of an organisation by its stakeholders, built over time through consistent behaviour and communication; it is an asset that must be measured and protected.",
    application: "Daily intelligence flags reputation risks; holding statements are drafted for owner review, never published automatically.",
    sourceTitle: "Fombrun, C. J. — Reputation: Realizing Value from the Corporate Image", sourceUrl: null, sourceRef: "Harvard Business School Press, 1996",
    publisher: "Harvard Business School Press", version: null, publishedYear: 1996,
    verification: "needs_review", verifiedNote: "Literature reference; not re-verified in this release.",
  },
  {
    slug: "scct-crisis-communication", category: "Crisis communication",
    title: "Situational Crisis Communication Theory (SCCT)",
    summary: "Crisis responses should match the level of responsibility stakeholders attribute to the organisation; crisis history and prior reputation intensify that attribution.",
    application: "Crisis-watch alerts classify the situation type and recommend a response strategy draft for owner approval.",
    sourceTitle: "Coombs, W. T. (2007). Protecting Organization Reputations During a Crisis: The Development and Application of Situational Crisis Communication Theory. Corporate Reputation Review, 10(3), 163–176.",
    sourceUrl: "https://doi.org/10.1057/palgrave.crr.1550049", sourceRef: "DOI 10.1057/palgrave.crr.1550049",
    publisher: "Corporate Reputation Review (Palgrave Macmillan)", version: null, publishedYear: 2007,
    verification: "verified", verifiedNote: "Citation and DOI confirmed via independent citation records.",
  },
  {
    slug: "brand-positioning", category: "Brand positioning",
    title: "Brand positioning: points of parity and difference",
    summary: "A clear positioning defines the frame of reference, the points of parity needed to compete and the points of difference that make the brand the preferred choice.",
    application: "The positioning statement in Brand Knowledge lists frame of reference, parity and difference — each backed by verified product facts.",
    sourceTitle: "Keller, K. L., Sternthal, B. & Tybout, A. — Three Questions You Need to Ask About Your Brand", sourceUrl: null, sourceRef: "Harvard Business Review, 2002",
    publisher: "Harvard Business Review", version: null, publishedYear: 2002,
    verification: "needs_review", verifiedNote: "Literature reference; not re-verified in this release.",
  },
  {
    slug: "media-relations-measurement", category: "Media relations",
    title: "Media relations measurement",
    summary: "Measure media relations by relevance and quality of coverage, message pull-through, audience fit and downstream outcomes — not by clip counts or advertising-value equivalents.",
    application: "Media Relations reports list each placement with source link and outlet relevance; no coverage is reported without a verifiable URL. Muck Rack data is used once its API access is verified.",
    sourceTitle: "AMEC — Integrated Evaluation Framework and Barcelona Principles", sourceUrl: "https://amecorg.com/", sourceRef: null,
    publisher: "AMEC", version: null, publishedYear: null,
    verification: "partially_verified", verifiedNote: "Derived from the AMEC framework and principles above.",
  },
];
