// ABD pazarlama/PR takvimi: resmî federal tatiller, gözlem günleri ve ticari fırsatlar.
// Saf modül (çalışma zamanı içe aktarımı yok). Tüm tarihler "YYYY-MM-DD" (UTC takvim günü) olarak hesaplanır.
//
// İlkeler:
//  - Federal tatiller 5 U.S.C. 6103 kuralıyla hesaplanır; hafta sonuna denk gelenlerin "gözlemlenen" (observed) günü
//    OPM kuralıyla ayrıca verilir (Cumartesi → önceki Cuma, Pazar → sonraki Pazartesi).
//  - Resmî tarih (official) ile ticari fırsat (commercial) ayrımı her kayıtta açıktır.
//  - Tarihi her yıl düzenleyici tarafından ilan edilen etkinlikler (müzik festivalleri, anime fuarları, Pollinator Week,
//    Ay Yeni Yılı gibi kural dışı tarihler) TAHMİN EDİLMEZ: date = null, requiresVerification = true.

export type ObservanceKind = "federal_holiday" | "observance" | "heritage_month" | "commercial" | "culture_event";

export type Observance = {
  id: string;
  name: string;
  kind: ObservanceKind;
  /** Resmî/gerçek tarih (tek günlük) veya dönemin ilk günü. Doğrulanmamış etkinliklerde null. */
  date: string | null;
  /** Çok günlü dönemlerin son günü (dahil). Tek günlük etkinlikte date ile aynı. */
  endDate: string | null;
  /** Federal tatil hafta sonuna denk gelirse federal çalışanlar için gözlemlenen gün. */
  observedDate?: string;
  /** Tarihin dayanağı: yasa, BM kararı, kural ("4th Thursday of November") veya "organizer announces yearly". */
  dateBasis: string;
  sourceUrl: string;
  /** true: tarih kural/yasa ile kesin. false: yaklaşık ticari dönem (ör. okula dönüş sezonu). */
  dateIsOfficial: boolean;
  requiresVerification: boolean;
  /** Etkinlik planlamasında kullanılan tema etiketleri (marka koleksiyonlarıyla eşleştirilir). */
  themes: string[];
  /** Hazırlık süresi kademesi: major 90 gün, standard 45 gün, minor 21 gün. */
  tier: "major" | "standard" | "minor";
  /** Sosyal amaç içeren etkinlik: bağış/ortaklık iddiası ancak doğrulanmış taahhütle yapılabilir. */
  causeRelated: boolean;
  notes?: string;
};

// ------------------------------------------------------------------ tarih yardımcıları (UTC)

export function ymd(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

export function parseYmd(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Geçersiz tarih: ${s}`);
  return new Date(`${s}T00:00:00Z`);
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / 86_400_000);
}

/** 0 = Pazar … 6 = Cumartesi */
export function weekday(s: string): number {
  return parseYmd(s).getUTCDay();
}

/** Ayın n. haftanın günü (n = 1..5). weekday 0 = Pazar. */
export function nthWeekday(year: number, month: number, dow: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  return ymd(year, month, day);
}

/** Ayın son belirtilen haftanın günü. */
export function lastWeekday(year: number, month: number, dow: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0));
  const diff = (lastDay.getUTCDay() - dow + 7) % 7;
  return ymd(year, month, lastDay.getUTCDate() - diff);
}

/** OPM kuralı: Cumartesi → önceki Cuma, Pazar → sonraki Pazartesi. */
export function observedFor(date: string): string {
  const w = weekday(date);
  if (w === 6) return addDays(date, -1);
  if (w === 0) return addDays(date, 1);
  return date;
}

export function thanksgiving(year: number): string {
  return nthWeekday(year, 11, 4, 4);
}

// ------------------------------------------------------------------ kayıtlar

const USC_6103 = "https://www.law.cornell.edu/uscode/text/5/6103";
const OPM_HOLIDAYS = "https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/";

function federal(id: string, name: string, date: string, basis: string, themes: string[], tier: Observance["tier"], extra: Partial<Observance> = {}): Observance {
  const observed = observedFor(date);
  return {
    id, name, kind: "federal_holiday", date, endDate: date,
    ...(observed !== date ? { observedDate: observed } : {}),
    dateBasis: basis, sourceUrl: USC_6103, dateIsOfficial: true, requiresVerification: false,
    themes, tier, causeRelated: false, ...extra,
  };
}

function single(id: string, name: string, kind: ObservanceKind, date: string, basis: string, sourceUrl: string, themes: string[], tier: Observance["tier"], extra: Partial<Observance> = {}): Observance {
  return { id, name, kind, date, endDate: date, dateBasis: basis, sourceUrl, dateIsOfficial: kind !== "commercial", requiresVerification: false, themes, tier, causeRelated: false, ...extra };
}

function period(id: string, name: string, kind: ObservanceKind, start: string, end: string, basis: string, sourceUrl: string, themes: string[], tier: Observance["tier"], extra: Partial<Observance> = {}): Observance {
  return { id, name, kind, date: start, endDate: end, dateBasis: basis, sourceUrl, dateIsOfficial: kind !== "commercial", requiresVerification: false, themes, tier, causeRelated: false, ...extra };
}

/** Bir takvim yılının tarihi kural/yasa ile kesin olan kayıtları. */
export function observancesForYear(year: number): Observance[] {
  const tg = thanksgiving(year);
  const list: Observance[] = [
    // --- 11 federal tatil (5 U.S.C. 6103)
    federal(`new-years-day-${year}`, "New Year's Day", ymd(year, 1, 1), "5 U.S.C. 6103: January 1", ["new-year", "fresh-start", "resolutions"], "standard"),
    federal(`mlk-day-${year}`, "Birthday of Martin Luther King, Jr.", nthWeekday(year, 1, 1, 3), "5 U.S.C. 6103: third Monday in January", ["civil-rights", "community", "service"], "minor", {
      causeRelated: true, notes: "Day of service; avoid sales-led messaging.",
    }),
    federal(`washingtons-birthday-${year}`, "Washington's Birthday (Presidents' Day)", nthWeekday(year, 2, 1, 3), "5 U.S.C. 6103: third Monday in February", ["sale", "winter"], "minor", {
      notes: "Official name is Washington's Birthday; 'Presidents' Day' is common/commercial usage.",
    }),
    federal(`memorial-day-${year}`, "Memorial Day", lastWeekday(year, 5, 1), "5 U.S.C. 6103: last Monday in May", ["summer-kickoff", "remembrance"], "standard", {
      notes: "Day of remembrance for fallen service members; keep commercial tone respectful.",
    }),
    federal(`juneteenth-${year}`, "Juneteenth National Independence Day", ymd(year, 6, 19), "5 U.S.C. 6103: June 19", ["black-culture", "freedom", "community"], "minor", {
      causeRelated: true, notes: "Avoid discount/sales framing; only amplify verified community partnerships.",
    }),
    federal(`independence-day-${year}`, "Independence Day", ymd(year, 7, 4), "5 U.S.C. 6103: July 4", ["summer", "americana", "festival"], "standard"),
    federal(`labor-day-${year}`, "Labor Day", nthWeekday(year, 9, 1, 1), "5 U.S.C. 6103: first Monday in September", ["end-of-summer", "sale", "back-to-school"], "standard"),
    federal(`columbus-day-${year}`, "Columbus Day", nthWeekday(year, 10, 1, 2), "5 U.S.C. 6103: second Monday in October", ["fall"], "minor", {
      notes: "Many states/cities observe Indigenous Peoples' Day on the same date; avoid brand messaging tied to the holiday name.",
    }),
    federal(`veterans-day-${year}`, "Veterans Day", ymd(year, 11, 11), "5 U.S.C. 6103: November 11", ["service", "community"], "minor"),
    federal(`thanksgiving-${year}`, "Thanksgiving Day", tg, "5 U.S.C. 6103: fourth Thursday in November", ["gratitude", "family", "holiday-season"], "standard"),
    federal(`christmas-${year}`, "Christmas Day", ymd(year, 12, 25), "5 U.S.C. 6103: December 25", ["holiday-season", "gifting"], "major"),

    // --- gözlem günleri (resmî ama tatil değil)
    period(`black-history-month-${year}`, "Black History Month", "heritage_month", ymd(year, 2, 1), ymd(year, 2, lastDayOfMonth(year, 2)), "Annual presidential proclamation (February)", "https://www.blackhistorymonth.gov/", ["black-culture", "community", "heritage"], "standard", { causeRelated: true }),
    single(`valentines-day-${year}`, "Valentine's Day", "commercial", ymd(year, 2, 14), "February 14 (cultural/commercial)", "https://www.britannica.com/topic/Valentines-Day", ["gifting", "love", "couples"], "standard"),
    period(`womens-history-month-${year}`, "Women's History Month", "heritage_month", ymd(year, 3, 1), ymd(year, 3, 31), "Annual presidential proclamation (March)", "https://womenshistorymonth.gov/", ["women", "community", "heritage"], "standard", { causeRelated: true }),
    single(`st-patricks-day-${year}`, "St. Patrick's Day", "commercial", ymd(year, 3, 17), "March 17 (cultural/commercial)", "https://www.britannica.com/topic/Saint-Patricks-Day", ["green", "festival"], "minor"),
    single(`earth-day-${year}`, "Earth Day", "observance", ymd(year, 4, 22), "April 22 (since 1970)", "https://www.earthday.org/", ["sustainability", "nature", "eco", "bee"], "standard", {
      causeRelated: true, notes: "Sustainability claims must be backed by verified product facts (FTC Green Guides).",
    }),
    period(`aapi-heritage-month-${year}`, "Asian American, Native Hawaiian, and Pacific Islander Heritage Month", "heritage_month", ymd(year, 5, 1), ymd(year, 5, 31), "Annual presidential proclamation (May)", "https://asianpacificheritage.gov/", ["aapi", "community", "heritage", "anime"], "standard", { causeRelated: true }),
    single(`mothers-day-${year}`, "Mother's Day", "observance", nthWeekday(year, 5, 0, 2), "36 U.S.C. 117: second Sunday in May", "https://www.law.cornell.edu/uscode/text/36/117", ["gifting", "family"], "standard"),
    single(`world-bee-day-${year}`, "World Bee Day", "observance", ymd(year, 5, 20), "UN General Assembly resolution A/RES/72/211: May 20", "https://www.un.org/en/observances/bee-day", ["bee", "pollinators", "nature", "sustainability"], "major", {
      causeRelated: true, notes: "Core brand-fit day for FriBee. Do not claim donations or conservation partnerships unless a verified commitment exists.",
    }),
    period(`pride-month-${year}`, "Pride Month", "heritage_month", ymd(year, 6, 1), ymd(year, 6, 30), "June (commemorates the 1969 Stonewall uprising)", "https://www.loc.gov/lgbt-pride-month/about/", ["pride", "lgbtq", "community", "self-expression"], "standard", {
      causeRelated: true, notes: "Avoid rainbow-washing: only reference verified, year-round commitments or partnerships.",
    }),
    single(`fathers-day-${year}`, "Father's Day", "observance", nthWeekday(year, 6, 0, 3), "36 U.S.C. 109: third Sunday in June", "https://www.law.cornell.edu/uscode/text/36/109", ["gifting", "family"], "standard"),
    period(`back-to-school-${year}`, "Back-to-school season", "commercial", ymd(year, 7, 15), nthWeekday(year, 9, 1, 1), "Commercial window (approx. mid-July → Labor Day); school start dates vary by district", "https://nrf.com/research-insights/holiday-and-seasonal-trends/back-to-class", ["back-to-school", "youth", "streetwear", "campus"], "major", {
      notes: "Approximate commercial window, not an official date.",
    }),
    period(`hispanic-heritage-month-${year}`, "National Hispanic Heritage Month", "heritage_month", ymd(year, 9, 15), ymd(year, 10, 15), "36 U.S.C. 126: September 15 – October 15", "https://www.hispanicheritagemonth.gov/", ["latino", "community", "heritage"], "standard", { causeRelated: true }),
    single(`halloween-${year}`, "Halloween", "commercial", ymd(year, 10, 31), "October 31 (cultural/commercial)", "https://www.britannica.com/topic/Halloween", ["costume", "spooky", "fall", "anime", "cosplay"], "standard"),
    single(`black-friday-${year}`, "Black Friday", "commercial", addDays(tg, 1), "Day after Thanksgiving (commercial)", "https://nrf.com/research-insights/holiday-and-seasonal-trends/thanksgiving", ["sale", "holiday-season", "gifting"], "major"),
    single(`small-business-saturday-${year}`, "Small Business Saturday", "commercial", addDays(tg, 2), "Saturday after Thanksgiving (commercial)", "https://www.sba.gov/", ["small-business", "community", "holiday-season"], "standard"),
    single(`cyber-monday-${year}`, "Cyber Monday", "commercial", addDays(tg, 4), "Monday after Thanksgiving (commercial)", "https://nrf.com/research-insights/holiday-and-seasonal-trends/thanksgiving", ["sale", "ecommerce", "holiday-season"], "major"),
    single(`giving-tuesday-${year}`, "GivingTuesday", "observance", addDays(tg, 5), "Tuesday after Thanksgiving", "https://www.givingtuesday.org/", ["giving", "community"], "minor", {
      causeRelated: true, notes: "No donation pledge may be published without a verified, owner-approved commitment.",
    }),
    single(`new-years-eve-${year}`, "New Year's Eve", "commercial", ymd(year, 12, 31), "December 31 (cultural/commercial)", "https://www.britannica.com/topic/New-Years-Eve", ["party", "year-in-review"], "minor"),
  ];
  return list;
}

/** Tarihi organizatör tarafından yıllık ilan edilen veya kural dışı olan etkinlikler: tarih TAHMİN EDİLMEZ. */
export const UNVERIFIED_CANDIDATES: Omit<Observance, "date" | "endDate">[] = [
  { id: "lunar-new-year", name: "Lunar New Year", kind: "observance", dateBasis: "Lunisolar calendar; varies yearly — enter verified date", sourceUrl: "https://www.britannica.com/topic/Lunar-New-Year", dateIsOfficial: true, requiresVerification: true, themes: ["aapi", "new-year", "community"], tier: "standard", causeRelated: false },
  { id: "pollinator-week", name: "National Pollinator Week", kind: "observance", dateBasis: "Dates set yearly by Pollinator Partnership — enter verified date", sourceUrl: "https://www.pollinator.org/pollinator-week", dateIsOfficial: true, requiresVerification: true, themes: ["bee", "pollinators", "nature"], tier: "major", causeRelated: true },
  { id: "anime-expo", name: "Anime Expo (Los Angeles)", kind: "culture_event", dateBasis: "Organizer announces yearly — enter verified date", sourceUrl: "https://www.anime-expo.org/", dateIsOfficial: true, requiresVerification: true, themes: ["anime", "cosplay", "youth"], tier: "standard", causeRelated: false },
  { id: "complexcon", name: "ComplexCon", kind: "culture_event", dateBasis: "Organizer announces yearly — enter verified date", sourceUrl: "https://www.complexcon.com/", dateIsOfficial: true, requiresVerification: true, themes: ["streetwear", "sneakers", "music"], tier: "standard", causeRelated: false },
  { id: "coachella", name: "Coachella Valley Music and Arts Festival", kind: "culture_event", dateBasis: "Organizer announces yearly — enter verified date", sourceUrl: "https://www.coachella.com/", dateIsOfficial: true, requiresVerification: true, themes: ["music", "festival", "fashion"], tier: "standard", causeRelated: false },
  { id: "new-york-fashion-week", name: "New York Fashion Week", kind: "culture_event", dateBasis: "CFDA schedule published per season — enter verified date", sourceUrl: "https://cfda.com/", dateIsOfficial: true, requiresVerification: true, themes: ["fashion", "runway", "press"], tier: "standard", causeRelated: false },
];

function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Yuvarlanan 12 aylık takvim: from (dahil) → from + 12 ay (hariç) aralığıyla KESİŞEN kayıtlar, tarihe göre sıralı.
 * verifiedDates: sahibin doğruladığı organizatör tarihleri (id → {date, endDate, sourceUrl}).
 */
export function rollingCalendar(
  from: string,
  verifiedDates: Record<string, { date: string; endDate?: string; sourceUrl: string }> = {},
): { events: Observance[]; unverified: Omit<Observance, "date" | "endDate">[] } {
  const start = parseYmd(from);
  const end = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate())).toISOString().slice(0, 10);
  const y = start.getUTCFullYear();
  const all = [...observancesForYear(y), ...observancesForYear(y + 1)];
  const unverified: Omit<Observance, "date" | "endDate">[] = [];
  for (const c of UNVERIFIED_CANDIDATES) {
    const v = verifiedDates[c.id];
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v.date) && /^https?:\/\//.test(v.sourceUrl)) {
      all.push({ ...c, id: `${c.id}-${v.date.slice(0, 4)}`, date: v.date, endDate: v.endDate ?? v.date, sourceUrl: v.sourceUrl, requiresVerification: false, dateBasis: `${c.dateBasis.split(" — ")[0]} — verified by owner` });
    } else unverified.push(c);
  }
  const events = all
    .filter((e) => e.date !== null && (e.endDate ?? e.date) >= from && e.date < end)
    .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : a.name.localeCompare(b.name)));
  return { events, unverified };
}
