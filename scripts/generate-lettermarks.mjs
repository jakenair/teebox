#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// generate-lettermarks.mjs — Country-club crest SVGs for Logo Bingo fallback.
// ─────────────────────────────────────────────────────────────────────────────
// For every course in bingo-courses.js, write a 256×256 SVG crest to
//   /assets/logos/{course-id}.svg
// using:
//   - a curated palette derived from the course's emoji theme / region
//   - cleanly chosen initials (1–3 chars, serif lettering)
//   - a double-ring crest design with subtle ornament
//
// Vector-only, no embedded raster, target <2 KB per file.
// Each SVG is parsed (lightweight well-formedness check) before write.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COURSES } from '../bingo-courses.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'assets/logos');

// ── Palettes ────────────────────────────────────────────────────────────────
// Each palette: { ring, ringInner, fill, text, accent }
//   ring       — outer ring stroke (the gold/silver crest border)
//   ringInner  — thin inner-ring stroke
//   fill       — main badge color
//   text       — initials + EST text color
//   accent     — small ornament color (laurel dots, est. underline)
const PALETTES = {
  coastal:  { ring: '#c9a44a', ringInner: '#e7d28a', fill: '#0d2a4a', text: '#f6f1de', accent: '#e7d28a' },
  augusta:  { ring: '#d4af37', ringInner: '#f3e2a0', fill: '#0a4d2c', text: '#fdfbf2', accent: '#f3e2a0' },
  pine:     { ring: '#caa75a', ringInner: '#ead7a1', fill: '#1f3a26', text: '#f4ecd6', accent: '#ead7a1' },
  irish:    { ring: '#d4af37', ringInner: '#f1d97a', fill: '#0c6e3f', text: '#fdf6dc', accent: '#f1d97a' },
  australian: { ring: '#1c2c4a', ringInner: '#3a527a', fill: '#c5a572', text: '#1c2c4a', accent: '#1c2c4a' },
  scottish: { ring: '#7a6a4a', ringInner: '#cbb98a', fill: '#4a4a4a', text: '#f4ecd6', accent: '#cbb98a' },
  desert:   { ring: '#b7894a', ringInner: '#e1c089', fill: '#8a4a2a', text: '#fbeed6', accent: '#e1c089' },
  japan:    { ring: '#c9a44a', ringInner: '#e7d28a', fill: '#a51c30', text: '#fdfbf2', accent: '#e7d28a' },
  vegas:    { ring: '#d4af37', ringInner: '#f3e2a0', fill: '#0e0e10', text: '#f3e2a0', accent: '#d4af37' },
  french:   { ring: '#c9a44a', ringInner: '#e7d28a', fill: '#1d2b58', text: '#f6f1de', accent: '#c0303f' },
  spanish:  { ring: '#caa75a', ringInner: '#ead7a1', fill: '#7a1a1a', text: '#f4ecd6', accent: '#ead7a1' },
  canadian: { ring: '#c9a44a', ringInner: '#e7d28a', fill: '#a4203b', text: '#fdfbf2', accent: '#e7d28a' },
  cherry:   { ring: '#c9a44a', ringInner: '#e7d28a', fill: '#5b1a3a', text: '#fdfbf2', accent: '#f5b8c2' },
  brand:    { ring: '#caa75a', ringInner: '#ead7a1', fill: '#0b3d1a', text: '#f4ecd6', accent: '#caa75a' },
};

// Map a course → palette key. Driven primarily by `logo` emoji + region cues.
function paletteFor(course) {
  const e = course.logo || '';
  const loc = (course.location || '').toLowerCase();
  const name = (course.name || '').toLowerCase();

  // Region-first overrides for unambiguous cases
  if (loc.includes('japan')) return 'japan';
  if (loc.includes('france')) return 'french';
  if (loc.includes('spain')) return 'spanish';
  if (loc.includes('canada')) return 'canadian';
  if (loc.includes('australia') || loc.includes('tasmania')) return 'australian';
  if (loc.includes('new zealand')) return 'australian';
  if (loc.includes('ireland') && !loc.includes('northern')) return 'irish';
  if (loc.includes('northern ireland')) return 'irish';
  if (loc.includes('scotland')) return 'scottish';
  if (loc.includes('nevada') && name.includes('shadow')) return 'vegas';

  // Emoji theming
  if (e === '🌷') return 'augusta'; // Augusta National
  if (e === '🌊' || e === '🌅' || e === '🏖️' || e === '🚤') return 'coastal';
  if (e === '🌲' || e === '🌳' || e === '🌿') return 'pine';
  if (e === '🍀' || e === '☘️' || e === '🇪🇺') return 'irish';
  if (e === '🦘' || e === '🚜') return 'australian';
  if (e === '🏰' || e === '👑' || e === '🏴󠁧󠁢󠁳󠁣󠁴󠁿' || e === '🪨') return 'scottish';
  if (e === '🏜️' || e === '🌾') return 'desert';
  if (e === '🌸' || e === '🗻' || e === '🗾') return 'japan';
  if (e === '🌑' || e === '⬛') return 'vegas';
  if (e === '🥖' || e === '🍇') return 'french';
  if (e === '🫒') return 'spanish';
  if (e === '🍁') return 'canadian';
  if (e === '🍊') return 'cherry'; // Cabot Citrus → warm

  // Default: TeeBox brand
  return 'brand';
}

// ── Initials picker ─────────────────────────────────────────────────────────
// Heuristics to pick 1–3 character initials.
// Strips connective words ("the", "of", "and", "&", "club", "golf", "country",
// "course", "links", "resort", "company", "no.", "association"), then takes
// the first letter of up to 3 remaining words. Single-word names use first
// two letters. Special-cased anomalies handled explicitly below.
const STOPWORDS = new Set([
  'the', 'of', 'and', 'at', 'a',
  'club', 'golf', 'country', 'course', 'links', 'resort', 'state', 'park',
  'gc', 'gcc', 'cc', 'cgc', 'company', 'companies', 'association',
  'gl', 'g&cc',
]);

const ID_OVERRIDES = {
  // Famous courses where the abbreviation diverges from a naive first-letter pick.
  'st-andrews-old':         'OC',  // "Old Course"
  'augusta-national':       'AN',
  'pebble-beach':           'PB',
  'pine-valley':            'PV',
  'cypress-point':          'CP',
  'shinnecock-hills':       'SH',
  'merion-east':            'ME',
  'national-golf-links':    'NGL',
  'fishers-island':         'FI',
  'sand-hills':             'SH',
  'pacific-dunes':          'PD',
  'bandon-dunes':           'BD',
  'old-macdonald':          'OM',
  'bandon-trails':          'BT',
  'sheep-ranch':            'SR',
  'chicago-golf-club':      'CGC',
  'winged-foot-west':       'WF',
  'seminole':               'S',
  'los-angeles-cc-north':   'LACC',
  'riviera':                'R',
  'oakland-hills-south':    'OH',
  'olympic-club-lake':      'OC',
  'san-francisco-gc':       'SF',
  'baltusrol-lower':        'BL',
  'bethpage-black':         'BB',
  'pinehurst-no-2':         'P2',
  'whistling-straits':      'WS',
  'erin-hills':             'EH',
  'tpc-sawgrass':           'TPC',
  'kiawah-ocean':           'KI',
  'harbour-town':           'HT',
  'tobacco-road':           'TR',
  'streamsong-red':         'SR',
  'streamsong-blue':        'SB',
  'streamsong-black':       'SBK',
  'cabot-citrus-farms':     'CCF',
  'inverness':              'IC',
  'crystal-downs':          'CD',
  'prairie-dunes':          'PD',
  'oak-hill-east':          'OH',
  'medinah-3':              'M3',
  'quaker-ridge':           'QR',
  'wade-hampton':           'WH',
  'east-lake':              'EL',
  'whispering-pines':       'WP',
  'castle-pines':           'CP',
  'shadow-creek':           'SC',
  'friars-head':            'FH',
  'somerset-hills':         'SH',
  'maidstone':              'M',
  'oakmont':                'O',
  'muirfield':              'M',
  'royal-dornoch':          'RD',
  'turnberry-ailsa':        'TA',
  'carnoustie':             'C',
  'north-berwick':          'NB',
  'kingsbarns':             'KB',
  'cruden-bay':             'CB',
  'machrihanish':           'M',
  'machrihanish-dunes':     'MD',
  'castle-stuart':          'CS',
  'royal-troon':            'RT',
  'royal-county-down':      'RCD',
  'royal-portrush-dunluce': 'RP',
  'ballybunion-old':        'B',
  'lahinch':                'L',
  'portmarnock':            'P',
  'european-club':          'EC',
  'royal-st-georges':       'RSG',
  'sunningdale-old':        'S',
  'royal-birkdale':         'RB',
  'royal-lytham':           'RL',
  'royal-liverpool':        'RL',
  'swinley-forest':         'SF',
  'walton-heath-old':       'WH',
  'morfontaine':            'M',
  'les-bordes':             'LB',
  'valderrama':             'V',
  'royal-melbourne-west':   'RM',
  'kingston-heath':         'KH',
  'barnbougle-dunes':       'BD',
  'barnbougle-lost-farm':   'LF',
  'cape-wickham':           'CW',
  'new-south-wales':        'NSW',
  'tara-iti':               'TI',
  'cape-kidnappers':        'CK',
  'cabot-cliffs':           'CC',
  'cabot-links':            'CL',
  'st-georges-canada':      'SG',
  'hamilton-gcc':           'H',
  'hirono':                 'H',
  'kawana-fuji':            'K',
  'tokyo-gc':               'TG',

  // Newly added courses
  'chambers-bay':                'CB',
  'black-mesa':                  'BM',
  'wolf-creek':                  'WC',
  'bayonne':                     'B',
  'old-sandwich':                'OS',
  'quail-hollow':                'QH',
  'wild-horse':                  'WH',
  'yeamans-hall':                'YH',
  'camargo-club':                'C',
  'old-town-club':               'OT',
  'sleepy-hollow':               'SH',
  'garden-city':                 'GC',
  'tpc-scottsdale':              'TPC',
  'tpc-river-highlands':         'TRH',
  'tpc-southwind':               'TPC',
  'detroit-golf-club':           'DGC',
  'colonial':                    'C',
  'muirfield-village':           'MV',
  'sand-valley':                 'SV',
  'mammoth-dunes':               'MD',
  'sedge-valley':                'SV',
  'forest-dunes':                'FD',
  'the-loop':                    'L',
  'arcadia-bluffs':              'AB',
  'spyglass-hill':               'SH',
  'monterey-peninsula-shore':    'MPS',
  'pasatiempo':                  'P',
  'congressional-blue':          'CC',
  'plainfield':                  'P',
  'aronimink':                   'A',
  'cherry-hills':                'CH',
  'southern-hills':              'SH',
  'firestone-south':             'FS',
  'olympia-fields-north':        'OF',
  'austin-cc':                   'ACC',
  'wolf-point':                  'WP',
  'ohoopee-match':               'OMC',
  'gozzer-ranch':                'GR',
  'congaree':                    'C',
  'royal-porthcawl':             'RP',
  'royal-ashdown-forest':        'RAF',
  'rye':                         'R',
  'st-georges-hill':             'SGH',
  'royal-cinque-ports':          'RCP',
  'royal-west-norfolk':          'RWN',
  'royal-aberdeen':              'RA',
  'trump-international-scotland':'TIS',
  'gleneagles-kings':            'GK',
  'gleneagles-pga-centenary':    'PGA',
  'prestwick':                   'P',
  'royal-st-davids':             'RSD',
  'old-head':                    'OH',
  'waterville':                  'W',
  'tralee':                      'T',
  'royal-dublin':                'RD',
  'county-sligo':                'CS',
  'enniscrone':                  'E',
  'royal-portrush-valley':       'RPV',
  'falsterbo':                   'F',
  'halmstad':                    'H',
  'sotogrande':                  'S',
  'la-reserva-sotogrande':       'LR',
  'real-san-sebastian':          'RSS',
  'le-touquet-la-mer':           'LT',
  'domaine-de-belesbat':         'DB',
  'fontainebleau':               'F',
  'club-zur-vahr':               'CZV',
  'pevero':                      'P',
  'hokkaido-classic':            'HC',
  'naruo':                       'N',
  'yas-links':                   'YL',
  'doha-golf-club':              'DGC',
  'emirates-majlis':             'EM',
  'mission-hills-shenzhen':      'MH',
  'diamante-dunes':              'DD',
  'cabot-saint-lucia':           'CSL',
  'casa-de-campo-teeth':         'TTD',
  'punta-espada':                'PE',
  'country-club-bogota':         'CCB',
  'royal-melbourne-east':        'RME',
  'victoria-golf-club':          'V',
  'metropolitan-melbourne':      'M',
  'ellerston':                   'E',
  'te-arai-south':               'TAS',
  'te-arai-north':               'TAN',
  'paraparaumu-beach':           'PB',
  'national-golf-club-canada':   'TNG',
  'highlands-links':             'HL',
  'jasper-park':                 'JP',
  'banff-springs':               'BS',
};

function pickInitials(course) {
  if (ID_OVERRIDES[course.id]) return ID_OVERRIDES[course.id];

  // Strip parenthetical bits like "(West)" — the variant is encoded in id.
  const base = (course.shortName || course.name)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[.,'’"&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = base.split(' ').filter(w => {
    if (!w) return false;
    if (STOPWORDS.has(w.toLowerCase())) return false;
    return true;
  });

  if (words.length === 0) return base.slice(0, 2).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();

  return words.slice(0, 3).map(w => w[0].toUpperCase()).join('');
}

// ── Founded years (curated, when widely known) ──────────────────────────────
// Omit when uncertain; the script will simply skip the EST. line.
const FOUNDED = {
  'augusta-national':       1933,
  'pine-valley':            1913,
  'cypress-point':          1928,
  'pebble-beach':           1919,
  'shinnecock-hills':       1891,
  'oakmont':                1903,
  'merion-east':            1912,
  'national-golf-links':    1911,
  'fishers-island':         1926,
  'sand-hills':             1995,
  'pacific-dunes':          2001,
  'bandon-dunes':           1999,
  'old-macdonald':          2010,
  'bandon-trails':          2005,
  'sheep-ranch':            2020,
  'chicago-golf-club':      1892,
  'winged-foot-west':       1923,
  'seminole':               1929,
  'los-angeles-cc-north':   1898,
  'riviera':                1926,
  'oakland-hills-south':    1916,
  'olympic-club-lake':      1924,
  'san-francisco-gc':       1895,
  'baltusrol-lower':        1895,
  'bethpage-black':         1936,
  'pinehurst-no-2':         1907,
  'whistling-straits':      1998,
  'erin-hills':             2006,
  'tpc-sawgrass':           1980,
  'kiawah-ocean':           1991,
  'harbour-town':           1969,
  'tobacco-road':           1998,
  'streamsong-red':         2012,
  'streamsong-blue':        2012,
  'streamsong-black':       2017,
  'cabot-citrus-farms':     1994,
  'inverness':              1903,
  'crystal-downs':          1929,
  'prairie-dunes':          1937,
  'oak-hill-east':          1926,
  'medinah-3':              1928,
  'quaker-ridge':           1916,
  'wade-hampton':           1987,
  'east-lake':              1904,
  'whispering-pines':       2000,
  'castle-pines':           1981,
  'shadow-creek':           1990,
  'friars-head':            2002,
  'somerset-hills':         1918,
  'maidstone':              1891,
  'st-andrews-old':         1552,
  'muirfield':              1891,
  'royal-dornoch':          1877,
  'turnberry-ailsa':        1906,
  'carnoustie':             1842,
  'north-berwick':          1832,
  'kingsbarns':             2000,
  'cruden-bay':             1899,
  'machrihanish':           1876,
  'machrihanish-dunes':     2009,
  'castle-stuart':          2009,
  'royal-troon':            1878,
  'royal-county-down':      1889,
  'royal-portrush-dunluce': 1888,
  'ballybunion-old':        1893,
  'lahinch':                1892,
  'portmarnock':            1894,
  'european-club':          1992,
  'royal-st-georges':       1887,
  'sunningdale-old':        1900,
  'royal-birkdale':         1889,
  'royal-lytham':           1886,
  'royal-liverpool':        1869,
  'swinley-forest':         1909,
  'walton-heath-old':       1903,
  'morfontaine':            1913,
  'les-bordes':             1986,
  'valderrama':             1985,
  'royal-melbourne-west':   1891,
  'kingston-heath':         1909,
  'barnbougle-dunes':       2004,
  'barnbougle-lost-farm':   2010,
  'cape-wickham':           2015,
  'new-south-wales':        1893,
  'tara-iti':               2015,
  'cape-kidnappers':        2004,
  'cabot-cliffs':           2015,
  'cabot-links':            2012,
  'st-georges-canada':      1929,
  'hamilton-gcc':           1894,
  'hirono':                 1932,
  'kawana-fuji':            1936,
  'tokyo-gc':               1914,

  // Newly added courses
  'chambers-bay':                2007,
  'black-mesa':                  2003,
  'wolf-creek':                  2001,
  'bayonne':                     2006,
  'old-sandwich':                2004,
  'quail-hollow':                1961,
  'wild-horse':                  1998,
  'yeamans-hall':                1925,
  'camargo-club':                1925,
  'old-town-club':               1939,
  'sleepy-hollow':               1911,
  'garden-city':                 1899,
  'tpc-scottsdale':              1986,
  'tpc-river-highlands':         1928,
  'tpc-southwind':               1988,
  'detroit-golf-club':           1899,
  'colonial':                    1936,
  'muirfield-village':           1974,
  'sand-valley':                 2017,
  'mammoth-dunes':               2018,
  'sedge-valley':                2024,
  'forest-dunes':                2002,
  'the-loop':                    2016,
  'arcadia-bluffs':              1999,
  'spyglass-hill':               1966,
  'monterey-peninsula-shore':    1961,
  'pasatiempo':                  1929,
  'congressional-blue':          1924,
  'plainfield':                  1890,
  'aronimink':                   1896,
  'cherry-hills':                1922,
  'southern-hills':              1936,
  'firestone-south':             1929,
  'olympia-fields-north':        1915,
  'austin-cc':                   1899,
  'congaree':                    2017,
  'royal-porthcawl':             1891,
  'royal-ashdown-forest':        1888,
  'rye':                         1894,
  'st-georges-hill':             1913,
  'royal-cinque-ports':          1892,
  'royal-west-norfolk':          1892,
  'royal-aberdeen':              1780,
  'trump-international-scotland':2012,
  'gleneagles-kings':            1919,
  'gleneagles-pga-centenary':    1993,
  'prestwick':                   1851,
  'royal-st-davids':             1894,
  'old-head':                    1997,
  'waterville':                  1889,
  'tralee':                      1984,
  'royal-dublin':                1885,
  'county-sligo':                1894,
  'enniscrone':                  1918,
  'royal-portrush-valley':       1947,
  'falsterbo':                   1909,
  'halmstad':                    1930,
  'sotogrande':                  1964,
  'la-reserva-sotogrande':       2003,
  'real-san-sebastian':          1910,
  'le-touquet-la-mer':           1904,
  'fontainebleau':               1909,
  'pevero':                      1972,
  'hokkaido-classic':            2004,
  'naruo':                       1920,
  'yas-links':                   2010,
  'doha-golf-club':              1996,
  'emirates-majlis':             1988,
  'mission-hills-shenzhen':      1992,
  'diamante-dunes':              2009,
  'cabot-saint-lucia':           2023,
  'casa-de-campo-teeth':         1971,
  'punta-espada':                2006,
  'country-club-bogota':         1917,
  'royal-melbourne-east':        1932,
  'victoria-golf-club':          1903,
  'metropolitan-melbourne':      1908,
  'ellerston':                   2001,
  'te-arai-south':               2022,
  'te-arai-north':               2023,
  'paraparaumu-beach':           1929,
  'national-golf-club-canada':   1976,
  'highlands-links':             1939,
  'jasper-park':                 1925,
  'banff-springs':               1927,
};

// ── SVG builder ─────────────────────────────────────────────────────────────
// 256×256 viewbox. Composition (centered on 128,128):
//   r=124  outer ring stroke (5px) — gold/silver crest border
//   r=110  inner ring stroke (1.5px) — subtle inset
//   r=104  solid fill disc
//   text   initials at center, serif, scaled to fit
//   small  EST. {year} arc-style flat label below initials (when known)
//   2 dots ornaments left/right of EST line
function buildSvg({ initials, palette, year }) {
  // Initial font size scales with character count to keep it visually balanced
  const len = initials.length;
  let fontSize;
  if (len <= 1) fontSize = 130;
  else if (len === 2) fontSize = 110;
  else if (len === 3) fontSize = 80;
  else fontSize = 64;

  const yLetters = year ? 144 : 154; // shift up to make room for EST line
  const showEst = !!year;
  const estFontSize = 14;

  // Hand-tuned geometry — keep numbers literal so there is no floating-point
  // noise in the output (helps gzip).
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="${escapeXml(initials)} crest">
  <defs>
    <radialGradient id="g" cx="50%" cy="42%" r="62%">
      <stop offset="0%" stop-color="${shade(palette.fill, 0.18)}"/>
      <stop offset="100%" stop-color="${palette.fill}"/>
    </radialGradient>
  </defs>
  <circle cx="128" cy="128" r="126" fill="${palette.ring}"/>
  <circle cx="128" cy="128" r="118" fill="url(#g)"/>
  <circle cx="128" cy="128" r="118" fill="none" stroke="${palette.ringInner}" stroke-width="1.2" opacity="0.65"/>
  <circle cx="128" cy="128" r="104" fill="none" stroke="${palette.ringInner}" stroke-width="1" opacity="0.45"/>
  <text x="128" y="${yLetters}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${fontSize}" fill="${palette.text}" letter-spacing="2">${escapeXml(initials)}</text>
  ${showEst ? `<g opacity="0.85">
    <line x1="86" y1="178" x2="118" y2="178" stroke="${palette.accent}" stroke-width="0.9"/>
    <line x1="138" y1="178" x2="170" y2="178" stroke="${palette.accent}" stroke-width="0.9"/>
    <text x="128" y="184" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${estFontSize}" fill="${palette.text}" letter-spacing="2">EST. ${year}</text>
  </g>` : ''}
  <circle cx="128" cy="58" r="2.5" fill="${palette.accent}"/>
  <circle cx="128" cy="206" r="2.5" fill="${palette.accent}"/>
</svg>
`;
}

// Lighten a hex color by mixing with white (used for radial-gradient highlight).
function shade(hex, mix) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const lr = Math.round(r + (255 - r) * mix);
  const lg = Math.round(g + (255 - g) * mix);
  const lb = Math.round(b + (255 - b) * mix);
  return '#' + [lr, lg, lb].map(n => n.toString(16).padStart(2, '0')).join('');
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  );
}

// Lightweight well-formedness check. We don't have a full XML parser in stdlib;
// validate that:
//   - tags are balanced
//   - every "<" has a matching ">"
//   - the document starts with <?xml and contains <svg ...> ... </svg>
// This catches malformed templates without pulling in a dependency.
function validateSvg(svg) {
  if (!svg.startsWith('<?xml')) throw new Error('missing XML prolog');
  if (!/<svg\b[^>]*>/.test(svg)) throw new Error('missing <svg> open tag');
  if (!/<\/svg>\s*$/.test(svg)) throw new Error('missing </svg> close tag');

  // Tag balance check
  const stack = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = tagRe.exec(svg))) {
    const full = m[0];
    const name = m[1];
    const selfClose = full.endsWith('/>') || m[2] === '/';
    if (full.startsWith('</')) {
      const top = stack.pop();
      if (top !== name) throw new Error(`unbalanced tag: </${name}> closes <${top}>`);
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length !== 0) throw new Error(`unclosed tags: ${stack.join(',')}`);

  // No stray '<' or '>' outside tags
  const stripped = svg.replace(tagRe, '').replace(/<\?xml[^?]*\?>/, '');
  if (stripped.includes('<') || stripped.includes('>')) {
    throw new Error('stray angle brackets in text content');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const failures = [];
  let ok = 0;
  let totalBytes = 0;
  const samples = [];

  for (const course of COURSES) {
    try {
      const initials = pickInitials(course);
      const palette = PALETTES[paletteFor(course)];
      const year = FOUNDED[course.id];
      const svg = buildSvg({ initials, palette, year });
      validateSvg(svg);

      const outPath = resolve(OUT_DIR, `${course.id}.svg`);
      await writeFile(outPath, svg, 'utf8');
      const s = await stat(outPath);
      totalBytes += s.size;
      ok += 1;
      if (samples.length < 5) {
        samples.push({ id: course.id, initials, bytes: s.size, palette: paletteFor(course) });
      }
    } catch (err) {
      failures.push({ id: course.id, error: err.message });
    }
  }

  console.log(`\nLogo Bingo lettermark generator`);
  console.log(`────────────────────────────────`);
  console.log(`Courses processed:   ${COURSES.length}`);
  console.log(`Lettermarks written: ${ok}`);
  console.log(`Total size:          ${(totalBytes / 1024).toFixed(1)} KB`);
  console.log(`Avg size:            ${ok ? Math.round(totalBytes / ok) : 0} bytes`);
  console.log(`Output:              ${OUT_DIR}`);

  if (samples.length) {
    console.log(`\nSamples:`);
    for (const s of samples) {
      console.log(`  ${s.id.padEnd(28)} ${s.initials.padEnd(5)} ${s.palette.padEnd(11)} ${s.bytes}b`);
    }
  }

  if (failures.length) {
    console.log(`\nFailures (${failures.length}):`);
    for (const f of failures) console.log(`  ${f.id}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
