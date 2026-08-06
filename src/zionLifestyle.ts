/**
 * Zion lifestyle helpers — free-first weather (Open-Meteo), places (OSM Overpass),
 * cinema listings, and chat short-circuit / fact packs. Location is ephemeral
 * (module memory only — never family memory).
 */

import { processZionFitnessNutritionChat } from './zionFitnessNutrition';

export interface ZionDeviceLocation {
  lat: number;
  lon: number;
  accuracy?: number;
  at: number;
  /** device | fallback | denied */
  source?: 'device' | 'fallback' | 'denied';
  /** Reverse-geocoded locality label (client or server) */
  areaLabel?: string;
}

export interface ZionLifestyleChatOpts {
  location?: ZionDeviceLocation | null;
  timeZone?: string;
}

export interface ZionLifestyleChatResult {
  handled: boolean;
  reply?: string;
  /** Inject into LLM system prompt when not fully short-circuited */
  facts?: string;
  /** Client should show Turn on location when device coords missing */
  needsLocation?: boolean;
}

/** Sunshine Coast, QLD — default when geolocation denied / missing */
export const ZION_FALLBACK_LOCATION: ZionDeviceLocation = {
  lat: -26.65,
  lon: 153.0667,
  at: 0,
  source: 'fallback',
};

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 45_000;
const OVERPASS_QUERY_TIMEOUT_S = 40;
const OVERPASS_CACHE_TTL_MS = 12 * 60 * 1000;
const OVERPASS_BACKOFF_MS = [1500, 3000] as const;

type OverpassCacheEntry = {
  at: number;
  places: ZionPlace[];
  ok: boolean;
  error?: string;
};
const overpassCache = new Map<string, OverpassCacheEntry>();

function overpassCacheKey(opts: {
  lat: number;
  lon: number;
  category: string;
  query?: string;
  radiusKm: number;
  limit: number;
}): string {
  const latR = Math.round(opts.lat * 100) / 100;
  const lonR = Math.round(opts.lon * 100) / 100;
  const q = String(opts.query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .slice(0, 40);
  return `${latR},${lonR}|${opts.category}|${q}|r${opts.radiusKm}|n${opts.limit}`;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(res: Response, attempt: number): number {
  const raw = res.headers.get('retry-after');
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(15_000, Math.max(500, secs * 1000));
    }
    const when = Date.parse(raw);
    if (Number.isFinite(when)) {
      return Math.min(15_000, Math.max(500, when - Date.now()));
    }
  }
  return OVERPASS_BACKOFF_MS[Math.min(attempt, OVERPASS_BACKOFF_MS.length - 1)];
}

/** Ephemeral last known device/fallback location (RAM only). */
let lastLocation: ZionDeviceLocation | null = null;
let lastTimeZone: string | undefined;

export function rememberZionLocation(
  loc: ZionDeviceLocation | null | undefined,
  timeZone?: string
): void {
  // Never remember Sunshine Coast / denied fallback as a device fix
  if (
    loc &&
    Number.isFinite(loc.lat) &&
    Number.isFinite(loc.lon) &&
    loc.source !== 'fallback' &&
    loc.source !== 'denied'
  ) {
    lastLocation = {
      lat: loc.lat,
      lon: loc.lon,
      accuracy:
        loc.accuracy != null && Number.isFinite(loc.accuracy)
          ? loc.accuracy
          : undefined,
      at: loc.at || Date.now(),
      source: loc.source || 'device',
      areaLabel: loc.areaLabel ? String(loc.areaLabel).slice(0, 120) : undefined,
    };
  }
  if (timeZone && String(timeZone).trim()) {
    lastTimeZone = String(timeZone).trim().slice(0, 80);
  }
}

export function getLastZionLocation(): ZionDeviceLocation | null {
  return lastLocation;
}

export function getLastZionTimeZone(): string | undefined {
  return lastTimeZone;
}

export function resolveZionCoords(
  loc?: ZionDeviceLocation | null
): { loc: ZionDeviceLocation; usedFallback: boolean } {
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    const source = loc.source === 'fallback' || loc.source === 'denied'
      ? loc.source
      : loc.source || 'device';
    const usedFallback = source === 'fallback' || source === 'denied';
    return {
      loc: {
        lat: loc.lat,
        lon: loc.lon,
        accuracy: loc.accuracy,
        at: loc.at || Date.now(),
        source,
        areaLabel: loc.areaLabel
          ? String(loc.areaLabel).slice(0, 120)
          : undefined,
      },
      usedFallback,
    };
  }
  if (lastLocation && Number.isFinite(lastLocation.lat)) {
    const usedFallback =
      lastLocation.source === 'fallback' || lastLocation.source === 'denied';
    return { loc: lastLocation, usedFallback };
  }
  return {
    loc: { ...ZION_FALLBACK_LOCATION, at: Date.now() },
    usedFallback: true,
  };
}

function areaPhrase(loc: ZionDeviceLocation): string {
  const label = String(loc.areaLabel || '').trim();
  return label || 'your area';
}

function weatherCodeLabel(code: number | undefined): string {
  if (code == null || !Number.isFinite(code)) return '';
  if (code === 0) return 'clear';
  if (code <= 3) return 'partly cloudy';
  if (code <= 48) return 'foggy';
  if (code <= 67) return 'rainy';
  if (code <= 77) return 'snowy';
  if (code <= 82) return 'showers';
  return 'stormy';
}

export async function getWeather(
  lat: number,
  lon: number,
  timeZone?: string
): Promise<{
  ok: boolean;
  line: string;
  tempC?: number;
  code?: number;
  sky?: string;
}> {
  const tz =
    (timeZone && String(timeZone).trim()) ||
    lastTimeZone ||
    'Australia/Brisbane';
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m` +
    `&timezone=${encodeURIComponent(tz)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal:
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(10_000)
          : undefined,
    });
    if (!res.ok) {
      return { ok: false, line: 'Weather unavailable right now (Open-Meteo).' };
    }
    const data = (await res.json()) as {
      current?: {
        temperature_2m?: number;
        weather_code?: number;
        relative_humidity_2m?: number;
        wind_speed_10m?: number;
      };
    };
    const temp = data.current?.temperature_2m;
    const code = data.current?.weather_code;
    const sky = weatherCodeLabel(code);
    const hum = data.current?.relative_humidity_2m;
    const wind = data.current?.wind_speed_10m;
    const tempS =
      temp != null && Number.isFinite(temp) ? `${Math.round(temp)}°C` : '—';
    const bits = [
      tempS,
      sky,
      hum != null && Number.isFinite(hum) ? `humidity ${Math.round(hum)}%` : '',
      wind != null && Number.isFinite(wind)
        ? `wind ${Math.round(wind)} km/h`
        : '',
    ].filter(Boolean);
    return {
      ok: true,
      line: bits.join(' · '),
      tempC: temp,
      code,
      sky,
    };
  } catch {
    return { ok: false, line: 'Weather unavailable right now (network).' };
  }
}

export type ZionPlaceCategory =
  | 'restaurant'
  | 'cafe'
  | 'fast_food'
  | 'pizza'
  | 'takeaway'
  | 'cinema'
  | 'gym'
  | 'futsal'
  | 'sports'
  | 'generic';

export interface ZionPlace {
  name: string;
  category: string;
  lat: number;
  lon: number;
  distKm: number;
  cuisine?: string;
  /** OSM tags that may hint popularity (stars, brand, etc.) — never invent virality */
  popularityHint?: string;
}

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Map natural-language food/activity words → Overpass category. */
export function mapPlaceCategory(text: string): ZionPlaceCategory | null {
  const t = text.toLowerCase();
  if (/\b(cinema|movie|movies|theatre|theater|film)\b/.test(t)) return 'cinema';
  if (/\b(futsal)\b/.test(t)) return 'futsal';
  if (/\b(gym|fitness|weights|workout\s*spot)\b/.test(t)) return 'gym';
  if (/\b(pizza)\b/.test(t)) return 'pizza';
  if (/\b(takeaway|take-away|take\s*out|takeout|delivery\s*food)\b/.test(t))
    return 'takeaway';
  if (/\b(cafe|coffee|brunch)\b/.test(t)) return 'cafe';
  if (/\b(fast\s*food|burger|mcdonald|kfc|drive.?thru)\b/.test(t))
    return 'fast_food';
  if (
    /\b(restaurant|dine.?in|dinner|lunch\s*out|eat\s*out|food\s*nearby|places\s*to\s*eat|where\s*(can|to)\s*eat)\b/.test(
      t
    )
  ) {
    return 'restaurant';
  }
  if (/\b(sport|sports\s*centre|sports\s*center|pitch)\b/.test(t))
    return 'sports';
  return null;
}

function overpassFilters(
  category: ZionPlaceCategory,
  query?: string
): string[] {
  const q = (query || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  switch (category) {
    case 'cinema':
      return ['node["amenity"="cinema"]', 'way["amenity"="cinema"]'];
    case 'gym':
      return [
        'node["leisure"="fitness_centre"]',
        'way["leisure"="fitness_centre"]',
        'node["amenity"="gym"]',
        'way["amenity"="gym"]',
        'node["leisure"="sports_centre"]["sport"~"fitness|gym",i]',
      ];
    case 'futsal':
      return [
        'node["leisure"="pitch"]["sport"="futsal"]',
        'way["leisure"="pitch"]["sport"="futsal"]',
        'node["leisure"="sports_centre"]["sport"~"futsal",i]',
        'way["leisure"="sports_centre"]["sport"~"futsal",i]',
        'node["sport"="futsal"]',
      ];
    case 'pizza':
      return [
        'node["amenity"~"restaurant|fast_food|cafe"]["cuisine"~"pizza",i]',
        'way["amenity"~"restaurant|fast_food|cafe"]["cuisine"~"pizza",i]',
        'node["amenity"="fast_food"]["name"~"pizza",i]',
        'way["amenity"="fast_food"]["name"~"pizza",i]',
      ];
    case 'takeaway':
      return [
        'node["amenity"="fast_food"]',
        'way["amenity"="fast_food"]',
        'node["takeaway"="yes"]',
        'way["takeaway"="yes"]',
      ];
    case 'cafe':
      return ['node["amenity"="cafe"]', 'way["amenity"="cafe"]'];
    case 'fast_food':
      return ['node["amenity"="fast_food"]', 'way["amenity"="fast_food"]'];
    case 'sports':
      return [
        'node["leisure"="sports_centre"]',
        'way["leisure"="sports_centre"]',
        'node["leisure"="pitch"]',
      ];
    case 'restaurant':
      return [
        'node["amenity"="restaurant"]',
        'way["amenity"="restaurant"]',
        'node["amenity"="cafe"]',
        'node["amenity"="fast_food"]',
      ];
    default: {
      if (q) {
        return [
          `node["amenity"~"restaurant|cafe|fast_food"]["name"~"${q}",i]`,
          `way["amenity"~"restaurant|cafe|fast_food"]["name"~"${q}",i]`,
          `node["name"~"${q}",i]["amenity"]`,
        ];
      }
      return [
        'node["amenity"="restaurant"]',
        'node["amenity"="cafe"]',
        'node["amenity"="fast_food"]',
      ];
    }
  }
}

function parseOverpassElements(
  elements: Array<Record<string, unknown>>,
  originLat: number,
  originLon: number
): ZionPlace[] {
  const out: ZionPlace[] = [];
  for (const el of elements) {
    const tags = (el.tags || {}) as Record<string, string>;
    const name = String(tags.name || tags.brand || '').trim();
    if (!name) continue;
    let lat = Number(el.lat);
    let lon = Number(el.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const c = el.center as { lat?: number; lon?: number } | undefined;
      lat = Number(c?.lat);
      lon = Number(c?.lon);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const distKm = haversineKm(originLat, originLon, lat, lon);
    const amenity = tags.amenity || tags.leisure || tags.sport || 'place';
    const popularityBits = [
      tags.stars ? `stars ${tags.stars}` : '',
      tags.brand ? `brand ${tags.brand}` : '',
      tags['official_name'] ? 'official listing' : '',
    ].filter(Boolean);
    out.push({
      name,
      category: amenity,
      lat,
      lon,
      distKm,
      cuisine: tags.cuisine,
      popularityHint: popularityBits.length
        ? popularityBits.join(', ')
        : undefined,
    });
  }
  out.sort((a, b) => a.distKm - b.distKm);
  // Dedupe by name+rounded distance
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = `${p.name.toLowerCase()}|${p.distKm.toFixed(2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function overpassBbox(lat: number, lon: number, radiusKm: number): {
  south: number;
  west: number;
  north: number;
  east: number;
} {
  const km = Math.max(0.5, Math.min(radiusKm, 40));
  const dLat = km / 111;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLon = km / (111 * Math.max(0.2, Math.abs(cos)));
  return {
    south: lat - dLat,
    west: lon - dLon,
    north: lat + dLat,
    east: lon + dLon,
  };
}

function isRetryableOverpassError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  return /abort|timeout|network|fetch|ECONN|ETIMEDOUT|socket|429|503|rate.?limit/i.test(
    msg
  );
}

export async function findPlaces(opts: {
  lat: number;
  lon: number;
  category: ZionPlaceCategory;
  query?: string;
  limit?: number;
  radiusKm?: number;
}): Promise<{ ok: boolean; places: ZionPlace[]; error?: string; rateLimited?: boolean }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 15));
  const radiusKm = Math.max(0.5, Math.min(opts.radiusKm ?? 8, 40));
  const cacheKey = overpassCacheKey({
    lat: opts.lat,
    lon: opts.lon,
    category: opts.category,
    query: opts.query,
    radiusKm,
    limit,
  });
  const cached = overpassCache.get(cacheKey);
  if (cached && Date.now() - cached.at < OVERPASS_CACHE_TTL_MS) {
    return {
      ok: cached.ok,
      places: cached.places.slice(),
      error: cached.error,
      rateLimited: /rate.?limit|429|503|busy/i.test(String(cached.error || '')),
    };
  }

  const filters = overpassFilters(opts.category, opts.query);
  const box = overpassBbox(opts.lat, opts.lon, radiusKm);
  const bbox = `(${box.south},${box.west},${box.north},${box.east})`;
  const around = filters.map((f) => `${f}${bbox};`).join('\n');
  const query = `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];\n(\n${around}\n);\nout center tags ${limit * 3};`;

  let lastErr = 'Overpass unavailable';
  let sawRateLimit = false;

  type AttemptResult = {
    places: ZionPlace[] | null;
    status?: number;
    retryAfterMs?: number;
  };

  const attemptFetch = async (endpoint: string): Promise<AttemptResult> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal:
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(OVERPASS_TIMEOUT_MS)
          : undefined,
    });
    if (res.status === 429 || res.status === 503) {
      sawRateLimit = true;
      lastErr = `Overpass HTTP ${res.status}`;
      return {
        places: null,
        status: res.status,
        retryAfterMs: parseRetryAfterMs(res, 0),
      };
    }
    if (!res.ok) {
      lastErr = `Overpass HTTP ${res.status}`;
      return { places: null, status: res.status };
    }
    const data = (await res.json()) as {
      elements?: Array<Record<string, unknown>>;
    };
    return {
      places: parseOverpassElements(data.elements || [], opts.lat, opts.lon)
        .filter((p) => p.distKm <= radiusKm + 0.15)
        .slice(0, limit),
      status: res.status,
    };
  };

  for (let mi = 0; mi < OVERPASS_URLS.length; mi++) {
    const endpoint = OVERPASS_URLS[mi];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await attemptFetch(endpoint);
        if (result.places) {
          overpassCache.set(cacheKey, {
            at: Date.now(),
            places: result.places,
            ok: true,
          });
          return { ok: true, places: result.places };
        }
        if (result.status === 429 || result.status === 503) {
          const backoff =
            result.retryAfterMs ??
            OVERPASS_BACKOFF_MS[Math.min(attempt, OVERPASS_BACKOFF_MS.length - 1)];
          await sleepMs(backoff);
          continue;
        }
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (attempt === 0 && isRetryableOverpassError(err)) {
          await sleepMs(OVERPASS_BACKOFF_MS[0]);
          continue;
        }
        break;
      }
    }
  }

  const friendly = sawRateLimit
    ? 'Maps are busy right now (rate limited). Trying again in a moment usually helps.'
    : isRetryableOverpassError(lastErr)
      ? 'Maps timed out — try again in a moment'
      : lastErr;
  overpassCache.set(cacheKey, {
    at: Date.now() - Math.floor(OVERPASS_CACHE_TTL_MS * 0.7),
    places: [],
    ok: false,
    error: friendly,
  });
  return {
    ok: false,
    places: [],
    error: friendly,
    rateLimited: sawRateLimit,
  };
}

function formatPlacesList(places: ZionPlace[], heading: string): string {
  if (!places.length) return `${heading}\n\nNothing turned up nearby in OpenStreetMap.`;
  const lines = places.map((p, i) => {
    const bits = [
      `**${p.name}**`,
      `${p.distKm < 1 ? `${Math.round(p.distKm * 1000)} m` : `${p.distKm.toFixed(1)} km`}`,
      p.cuisine ? p.cuisine.replace(/;/g, ', ') : p.category,
      p.popularityHint ? `(OSM: ${p.popularityHint})` : '',
    ].filter(Boolean);
    return `${i + 1}. ${bits.join(' · ')}`;
  });
  return `${heading}\n\n${lines.join('\n')}`;
}

function hasShowtimesApiKey(): boolean {
  return Boolean(
    String(process.env.ZION_CINEMA_SHOWTIMES_API_KEY || '').trim()
  );
}

async function cinemaReply(
  loc: ZionDeviceLocation,
  usedFallback: boolean
): Promise<string> {
  let found = await findPlaces({
    lat: loc.lat,
    lon: loc.lon,
    category: 'cinema',
    limit: 3,
    radiusKm: 12,
  });
  let radiusUsed = 12;
  if (found.ok && !found.places.length) {
    found = await findPlaces({
      lat: loc.lat,
      lon: loc.lon,
      category: 'cinema',
      limit: 3,
      radiusKm: 25,
    });
    radiusUsed = 25;
  } else if (!found.ok && found.rateLimited) {
    await sleepMs(OVERPASS_BACKOFF_MS[1]);
    found = await findPlaces({
      lat: loc.lat,
      lon: loc.lon,
      category: 'cinema',
      limit: 3,
      radiusKm: 12,
    });
    if (found.ok && !found.places.length) {
      found = await findPlaces({
        lat: loc.lat,
        lon: loc.lon,
        category: 'cinema',
        limit: 3,
        radiusKm: 25,
      });
      radiusUsed = 25;
    }
  }
  const area = areaPhrase(loc);
  const fallbackNote = usedFallback
    ? '\n\n_(I don’t have your device location — turn on location for nearby results.)_'
    : '';
  if (!found.ok) {
    return (
      `I couldn't reach OpenStreetMap for cinemas near ${area} just now (${found.error || 'error'}). Try again shortly.` +
      fallbackNote
    );
  }
  const list = formatPlacesList(
    found.places,
    `Nearby cinemas near ${area} (OpenStreetMap, within ~${radiusUsed} km):`
  );
  let showtimesNote: string;
  if (!hasShowtimesApiKey()) {
    showtimesNote =
      '\n\nLive showtimes: I don’t have a showtimes API key (`ZION_CINEMA_SHOWTIMES_API_KEY`), so I won’t invent screening times — check the cinema’s site or app.';
  } else {
    showtimesNote =
      '\n\nA showtimes API key is set, but I still won’t invent times. Use the cinema listings above and confirm sessions on their site/app (provider wiring is best-effort only).';
  }
  return list + showtimesNote + fallbackNote;
}

function locationNeededReply(): ZionLifestyleChatResult {
  return {
    handled: true,
    needsLocation: true,
    reply:
      'I need your device location to complete that — I can’t finish without it. Please turn on location (allow when the browser asks), then ask me again.\n\n[[ZION_TURN_ON_LOCATION]]' +
      footer(),
  };
}

function needsDeviceLocation(usedFallback: boolean, loc: ZionDeviceLocation): boolean {
  return usedFallback || loc.source === 'fallback' || loc.source === 'denied';
}

function looksLikeWeather(text: string): boolean {
  return /\b(weather|forecast|temperature|how\s+hot|how\s+cold|raining|rain\s+today|umbrella|humid)\b/i.test(
    text
  );
}

function looksLikePlaces(text: string): boolean {
  return (
    mapPlaceCategory(text) != null ||
    /\b(near\s*me|nearby|around\s*here|close\s*by|where\s*(can|to)|recommend.*(eat|food|cafe|gym|cinema)|find\s+(a|me)\s+)/i.test(
      text
    )
  );
}

function looksLikeVirality(text: string): boolean {
  return /\b(viral|trending\s+on\s+(ig|insta|instagram|tiktok|tt)|instagram\s+famous|influencer|tiktok\s+famous)\b/i.test(
    text
  );
}

function footer(): string {
  return '\n\n~ Zion Valton';
}

/**
 * Lifestyle + fitness chat handler.
 * Returns a direct reply when short-circuited; otherwise optional facts for the LLM.
 */
export async function processZionLifestyleChat(
  userText: string,
  opts?: ZionLifestyleChatOpts
): Promise<ZionLifestyleChatResult> {
  const text = String(userText || '').trim();
  if (!text) return { handled: false };

  if (opts?.location && opts.location.source !== 'fallback' && opts.location.source !== 'denied') {
    rememberZionLocation(opts.location, opts.timeZone);
  } else if (opts?.timeZone) {
    rememberZionLocation(null, opts.timeZone);
  }

  const { loc, usedFallback } = resolveZionCoords(opts?.location ?? lastLocation);
  const tz = opts?.timeZone || lastTimeZone;

  // Fitness / nutrition first (may be mid-consult)
  try {
    const fit = await processZionFitnessNutritionChat(text);
    if (fit.handled && fit.reply) {
      return { handled: true, reply: fit.reply };
    }
    if (fit.facts) {
      // Continue — may also want places/weather facts; fitness facts injected below if not handled
      if (!looksLikeWeather(text) && !looksLikePlaces(text) && !looksLikeVirality(text)) {
        return { handled: false, facts: fit.facts };
      }
    }
  } catch (err) {
    console.warn(
      '[zion-lifestyle] fitness handler failed',
      err instanceof Error ? err.message : err
    );
  }

  if (looksLikeVirality(text)) {
    if (needsDeviceLocation(usedFallback, loc)) {
      return locationNeededReply();
    }
    const cat = mapPlaceCategory(text) || 'restaurant';
    let found = await findPlaces({
      lat: loc.lat,
      lon: loc.lon,
      category: cat,
      limit: 6,
      radiusKm: 10,
    }).catch(() => ({
      ok: false as const,
      places: [] as ZionPlace[],
      error: 'fail',
      rateLimited: false,
    }));
    if (!found.ok && found.rateLimited) {
      await sleepMs(OVERPASS_BACKOFF_MS[1]);
      found = await findPlaces({
        lat: loc.lat,
        lon: loc.lon,
        category: cat,
        limit: 6,
        radiusKm: 10,
      }).catch(() => ({
        ok: false as const,
        places: [] as ZionPlace[],
        error: 'fail',
        rateLimited: true,
      }));
    }
    const osmBits = found.ok && found.places.length
      ? formatPlacesList(
          found.places,
          `Nearby OpenStreetMap places near ${areaPhrase(loc)} (tags only — not social virality):`
        )
      : found.rateLimited
        ? 'Maps are busy right now (rate limited) — try again in a moment.'
        : 'I couldn’t pull OSM places right now.';
    return {
      handled: true,
      reply:
        `I can’t verify Instagram/TikTok virality without those APIs — I won’t invent follower counts or “trending” claims.\n\n` +
        osmBits +
        footer(),
    };
  }

  if (looksLikeWeather(text)) {
    if (needsDeviceLocation(usedFallback, loc)) {
      return locationNeededReply();
    }
    const w = await getWeather(loc.lat, loc.lon, tz);
    const area = areaPhrase(loc);
    return {
      handled: true,
      reply:
        (w.ok
          ? `Weather near ${area}: **${w.line}** (Open-Meteo).`
          : `Couldn't fetch weather for ${area}: ${w.line}`) + footer(),
    };
  }

  const cinemaAsk = /\b(cinema|movie|movies|showtimes?|film)\b/i.test(text);
  if (cinemaAsk) {
    if (needsDeviceLocation(usedFallback, loc)) {
      return locationNeededReply();
    }
    const reply = await cinemaReply(loc, false);
    return { handled: true, reply: reply + footer() };
  }

  if (looksLikePlaces(text)) {
    if (needsDeviceLocation(usedFallback, loc)) {
      return locationNeededReply();
    }
    const category = mapPlaceCategory(text) || 'restaurant';
    let radiusKm =
      category === 'cinema' ? 12 : category === 'gym' || category === 'futsal' ? 15 : 8;
    let found = await findPlaces({
      lat: loc.lat,
      lon: loc.lon,
      category,
      limit: category === 'cinema' ? 3 : 8,
      radiusKm,
    });
    if (category === 'cinema' && found.ok && !found.places.length) {
      radiusKm = 25;
      found = await findPlaces({
        lat: loc.lat,
        lon: loc.lon,
        category,
        limit: 3,
        radiusKm,
      });
    } else if (!found.ok && found.rateLimited) {
      await sleepMs(OVERPASS_BACKOFF_MS[1]);
      found = await findPlaces({
        lat: loc.lat,
        lon: loc.lon,
        category,
        limit: category === 'cinema' ? 3 : 8,
        radiusKm,
      });
      if (category === 'cinema' && found.ok && !found.places.length) {
        radiusKm = 25;
        found = await findPlaces({
          lat: loc.lat,
          lon: loc.lon,
          category,
          limit: 3,
          radiusKm,
        });
      }
    }
    const label =
      category === 'pizza'
        ? 'pizza spots'
        : category === 'takeaway'
          ? 'takeaway / fast food'
          : category === 'cafe'
            ? 'cafes'
            : category === 'gym'
              ? 'gyms / fitness'
              : category === 'futsal'
                ? 'futsal / pitches'
                : category === 'fast_food'
                  ? 'fast food'
                  : category === 'cinema'
                    ? 'cinemas'
                    : 'places to eat';
    const area = areaPhrase(loc);
    if (!found.ok) {
      return {
        handled: true,
        reply:
          `I couldn't reach OpenStreetMap for ${label} near ${area} (${found.error || 'error'}). Soft-fail — try again in a bit.` +
          footer(),
      };
    }
    const heading = `Nearby ${label} near ${area} (OpenStreetMap):`;
    return {
      handled: true,
      reply: formatPlacesList(found.places, heading) + footer(),
    };
  }

  // Soft facts for LLM when lifestyle-adjacent but not a hard short-circuit
  if (
    /\b(outside|walk|humid|sunny|dinner|lunch|breakfast|hungry|train(ing)?|workout|macros?|calories|diet)\b/i.test(
      text
    )
  ) {
    const facts: string[] = [];
    if (!needsDeviceLocation(usedFallback, loc)) {
      try {
        const w = await getWeather(loc.lat, loc.lon, tz);
        if (w.ok) {
          facts.push(`Local weather (device/area): ${w.line}`);
        }
      } catch {
        /* soft */
      }
    } else {
      facts.push(
        'Location note: device location is off; ask Dad to turn location on before local recommendations.'
      );
    }
    if (facts.length) {
      return { handled: false, facts: facts.join('\n') };
    }
  }

  return { handled: false };
}
