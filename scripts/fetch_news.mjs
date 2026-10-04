// Pulls recent headlines from South African news RSS feeds, tags the parties
// each story mentions, and merges them into news.json (rolling 30-day window).
// No dependencies — runs on Node 18+. Used by .github/workflows/update-news.yml.
//
// Headlines are shown on the site as context only; they never change a party's
// trust rating, which is calculated from the curated record in trust.json.

import { readFile, writeFile } from 'node:fs/promises';

const OUT_FILE = new URL('../news.json', import.meta.url);
const WINDOW_DAYS = 30;
const MAX_PER_PARTY = 40;

const FEEDS = [
  { source: 'Daily Maverick', homepage: 'https://www.dailymaverick.co.za', url: 'https://www.dailymaverick.co.za/dmrss/' },
  { source: 'News24',         homepage: 'https://www.news24.com',          url: 'https://feeds.capi24.com/v1/Search/articles/news24/Politics/rss' },
  { source: 'News24',         homepage: 'https://www.news24.com',          url: 'https://feeds.capi24.com/v1/Search/articles/news24/TopStories/rss' },
  { source: 'GroundUp',       homepage: 'https://groundup.org.za',         url: 'https://groundup.org.za/sitenews/rss/' },
  { source: 'The Citizen',    homepage: 'https://www.citizen.co.za',       url: 'https://www.citizen.co.za/feed/' },
  { source: 'SABC News',      homepage: 'https://www.sabcnews.com',        url: 'https://www.sabcnews.com/sabcnews/feed/' },
  { source: 'IOL',            homepage: 'https://iol.co.za',               url: 'https://iol.co.za/rss' },
];

// Case-sensitive where an acronym would otherwise match ordinary words.
const PARTY_PATTERNS = {
  anc:        [/\bANC\b/, /African National Congress/i],
  da:         [/\bDA\b/, /Democratic Alliance/i],
  eff:        [/\bEFF\b/, /Economic Freedom Fighters/i, /\bMalema\b/],
  mkp:        [/\bMK Party\b/i, /\bMKP\b/, /uMkhonto we ?Sizwe/i, /\bJacob Zuma\b/],
  actionsa:   [/\bActionSA\b/i, /\bMashaba\b/],
  risemzansi: [/\bRise Mzansi\b/i, /\bSongezo Zibi\b/],
  bosa:       [/\bBOSA\b/, /Build One South Africa/i, /\bMaimane\b/],
  ifp:        [/\bIFP\b/, /Inkatha Freedom Party/i, /\bHlabisa\b/],
  ffplus:     [/\bFF ?Plus\b/i, /\bFF\+/, /Freedom Front Plus/i, /\bVF Plus\b/i],
  pa:         [/Patriotic Alliance/i, /\bGayton McKenzie\b/, /\bKenny Kunene\b/],
  good:       [/\bGOOD party\b/i, /\bPatricia de Lille\b/i, /\bBrett Herron\b/],
  atm:        [/African Transformation Movement/i, /\bZungula\b/],
  aljamaah:   [/\bAl Jama-?ah\b/i, /\bGanief Hendricks\b/, /\bGwamanda\b/],
};

const ACCOUNTABILITY_TERMS = /\b(corrupt\w*|fraud\w*|bribe\w*|charged|charges|arrest\w*|convict\w*|acquit\w*|court|Hawks|SIU|Public Protector|tender\w*|investigat\w*|commission|state capture|looting|irregular|misconduct|impeach\w*)\b/i;

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function parseItems(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map(b => ({
    title: tag(b, 'title'),
    link: tag(b, 'link'),
    description: tag(b, 'description'),
    published: tag(b, 'pubDate'),
  }));
}

function partiesMentioned(text) {
  return Object.entries(PARTY_PATTERNS)
    .filter(([, patterns]) => patterns.some(re => re.test(text)))
    .map(([id]) => id);
}

async function fetchFeed({ source, url }) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SA-Political-Compass-NewsBot/1.0 (+https://github.com/Kwamza/SA_political_compass)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = parseItems(await res.text());
  return items.map(i => ({ ...i, source }));
}

async function loadExisting() {
  try {
    return JSON.parse(await readFile(OUT_FILE, 'utf8')).items || [];
  } catch {
    return [];
  }
}

async function main() {
  const fresh = [];
  const feedStatus = [];
  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      fresh.push(...items);
      feedStatus.push({ source: feed.source, homepage: feed.homepage, url: feed.url, ok: true, items: items.length });
    } catch (err) {
      feedStatus.push({ source: feed.source, homepage: feed.homepage, url: feed.url, ok: false, error: String(err.message || err) });
      console.warn(`Feed failed: ${feed.url} — ${err.message || err}`);
    }
  }

  const tagged = fresh
    .filter(i => i.title && /^https:\/\//.test(i.link))
    .map(i => {
      const text = `${i.title} ${i.description}`;
      const date = new Date(i.published);
      return {
        title: i.title.replace(/^News24\s*\|\s*/i, ''),
        link: i.link,
        source: i.source,
        published: isNaN(date) ? new Date().toISOString() : date.toISOString(),
        parties: partiesMentioned(text),
        accountability: ACCOUNTABILITY_TERMS.test(text),
      };
    })
    .filter(i => i.parties.length > 0);

  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  const byLink = new Map();
  for (const item of [...(await loadExisting()), ...tagged]) {
    if (new Date(item.published).getTime() >= cutoff) byLink.set(item.link, item);
  }

  const sorted = [...byLink.values()].sort((a, b) => b.published.localeCompare(a.published));

  // Cap each party's share so the busiest parties don't crowd out the rest.
  const perParty = {};
  const items = sorted.filter(item => {
    const keep = item.parties.some(p => (perParty[p] || 0) < MAX_PER_PARTY);
    if (keep) item.parties.forEach(p => { perParty[p] = (perParty[p] || 0) + 1; });
    return keep;
  });

  await writeFile(OUT_FILE, JSON.stringify({
    updated: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    feeds: feedStatus,
    items,
  }, null, 2) + '\n');

  console.log(`news.json: ${items.length} items (${tagged.length} new matches from ${fresh.length} headlines)`);
  if (feedStatus.every(f => !f.ok)) process.exit(1);
}

main();
