// TeeBox design tokens — source of truth.
//
// This file is the canonical definition of every color, spacing value,
// font size, border-radius, and shadow used in the TeeBox UI. The web app
// (index.html) currently inlines CSS values directly; the long-term plan
// is to consume these tokens from CSS custom properties declared in the
// `:root` block of index.html (lines 146-165).
//
// When adding a new value: prefer using an existing token. Only add a new
// token here if no existing one is within +/-10% (colors), +/-2px (spacing),
// or +/-1 step (border-radius).
//
// Generated from a codebase audit on 2026-05-10. Update on every redesign.

/* -------------------------------------------------------------------------- */
/*  PRIMITIVES                                                                */
/* -------------------------------------------------------------------------- */

export const colors = {
  // -------------------------------------------------------------------------
  // Brand greens. The codebase already declares a full 50..950 scale on
  // :root (index.html:147-150). Keep this list 1:1 with those vars.
  // -------------------------------------------------------------------------
  brand: {
    green50:  '#edf6ee',
    green100: '#d0e9d4',
    green200: '#9fcfa9',
    green300: '#6aad7c',
    green400: '#4d8a5e',
    green500: '#3a6b47',
    green600: '#2d5438', // primary CTA bg — `.auth-btn` / `.btn-buy` / `.btn-full.green`
    green700: '#22402b', // toast bg, brand chips, hero gradient stop
    green800: '#1a3020',
    green900: '#122016', // modal header / page chrome
    green950: '#0b1a0e', // meta theme-color (manifest.webmanifest:11, index.html:9)
  },
  // -------------------------------------------------------------------------
  // Gold accent scale. Several ad-hoc gold hexes outside this scale are
  // flagged below as duplicates and SHOULD be migrated.
  // -------------------------------------------------------------------------
  gold: {
    /** Canonical for hover/lighter accent. Merges legacy `#f3d68a`,`#f0c850`,`#e7d28a`. */
    gold300: '#f0cc6a',
    /** Canonical for primary gold CTA (`.btn-primary`). Merges `#d4af37`*8, `#e0b840`*2. */
    gold400: '#e0b840',
    /** Canonical for "wordmark gold". Merges `#d6a900`*6, `#c9991e`. */
    gold500: '#c9991e',
    gold600: '#a07a12', // also referenced as `--gold-600,#b88a00`
    gold700: '#7a5c0a',
  },
  // -------------------------------------------------------------------------
  // Neutrals. Cream/white background, plus a gray scale.
  // -------------------------------------------------------------------------
  neutral: {
    white:  '#ffffff',
    cream:  '#faf8f3', // page bg via `body { background: var(--cream) }`
    gray100: '#f4f4f2',
    gray200: '#e8e8e4',
    gray300: '#d0d0ca',
    gray400: '#a8a89e',
    gray500: '#7a7a72',
    gray700: '#3c3c38',
    gray900: '#1c1c18',
    black:   '#000000',
  },
  // -------------------------------------------------------------------------
  // Semantic accents.
  // -------------------------------------------------------------------------
  status: {
    /** danger / refund / down-tick. Merges `--red-500` and `--dn-red`. */
    danger:     '#c0392b',
    dangerBg:   '#fde8e6', // `--red-100` / `--dn-bg`
    /** "up tick" green used in price deltas only. Slightly bluer than brand. */
    upGreen:    '#1a8a3c',
    upBg:       '#e8f7ed',
    /** Reaction heart color. Only used by like/heart UI. */
    heart:      '#e74c3c',
    blue500:    '#3b82f6',
    blue700:    '#1d4ed8',
    blue100:    '#dbeafe',
  },
  // -------------------------------------------------------------------------
  // Surfaces — semantic aliases for background layers.
  // -------------------------------------------------------------------------
  surface: {
    page:     '#faf8f3',           // body bg (= neutral.cream)
    card:     '#ffffff',           // .product-card, .modal, .info-modal
    chrome:   '#122016',           // modal header, hero gradient deep end
    chromeAlt:'#0b1a0e',           // PWA theme-color, hero base
    /** Modal scrim. NOTE: 4 variants in the wild (0.5/0.55/0.6/0.75). */
    scrim:    'rgba(0,0,0,0.6)',   // canonical (.modal-backdrop:1474)
    scrimDeep:'rgba(0,0,0,0.75)',  // detail-backdrop only (.detail-backdrop:1508)
    /** Glass overlays on dark hero (cat-pill rest/hover). */
    overlayLight4:  'rgba(255,255,255,0.04)',
    overlayLight7:  'rgba(255,255,255,0.07)',
    overlayLight12: 'rgba(255,255,255,0.12)',
  },
} as const;

/* -------------------------------------------------------------------------- */

export const spacing = {
  // 2px base; the codebase clusters around 4/6/8/10/12/14/16/24.
  // Values below are in pixels.
  px:    1,
  xxs:   2,  // condition pill / dense badge gap. 9x `gap: 2px`
  xs:    4,  // badge inner pad
  sm:    6,  // pill gap, label gap
  md:    8,  // standard gap (19x `gap: 8px`)
  lg:    10, // most common gap (31x `gap: 10px`)
  xl:    12, // most common gap (28x `gap: 12px`)
  '2xl': 14, // .toast vertical pad, .btn-buy-now pad
  '3xl': 16, // standard card padding (`1rem`)
  '4xl': 20,
  '5xl': 24, // section margin (`1.5rem`)
  '6xl': 32, // 2rem hero spacing
  '7xl': 48, // 3rem hero
  '8xl': 64, // 4rem hero
} as const;

export const fontSizes = {
  // px-based scale. Decimals (`.5`) get rounded to nearest integer step.
  // Legacy `13.5px` (23 usages) and `12.5px` (19 usages) MERGE → 13 / 12.
  '2xs':  10, // micro-labels, badges
  xs:     11, // 43 uses
  sm:     12, // 64 uses — most common
  base:   13, // 60 uses — body copy in dense lists
  md:     14, // 42 uses — body copy default
  lg:     15, // 18 uses — body / button label
  xl:     16, // 13 uses — input font, default body line
  '2xl':  18,
  '3xl':  20,
  '4xl':  22,
  '5xl':  28,
  display1: 24, // `1.5rem` heading
  display2: 32, // `2rem` heading
  display3: 48, // `3rem` hero heading
  display4: 56, // `3.5rem` largest hero
} as const;

export const borderRadius = {
  // Already on :root as `--radius-sm/md/lg/xl` (index.html:162).
  none:  0,
  xs:    2,  // pill micro (.product-rank-pill)
  sm:    4,  // var(--radius-sm)
  md:    8,  // var(--radius-md)  — 47 uses (most common)
  lg:    14, // var(--radius-lg) — card / info-modal
  xl:    20, // var(--radius-xl) — modal / sell-modal / detail-modal
  pill:  9999, // canonical pill. Codebase mixes `50px` (39 uses) + `999px` (16). MERGE.
  circle: '50%',
} as const;

export const fontFamilies = {
  display: "'Playfair Display', Georgia, serif", // --font-display, 58 uses
  body:    "'DM Sans', system-ui, sans-serif",   // --font-body, 58 uses
} as const;

export const shadows = {
  // Canonical pair already in :root (index.html:163).
  card:     '0 2px 12px rgba(0,0,0,0.08)',  // --shadow-card
  hover:    '0 8px 32px rgba(0,0,0,0.14)',  // --shadow-hover
  // Toast-class drop, slightly heavier than --shadow-hover.
  toast:    '0 8px 32px rgba(0,0,0,0.2)',
  // Gold-ring glows for "verified" listings — keep as bespoke component shadow.
  verifyGlow: '0 0 0 1px rgba(214,169,0,0.22), 0 8px 32px rgba(214,169,0,0.18)',
  goldRing:   '0 2px 12px rgba(212,175,55,0.35)', // .cat-pill.active
  none: 'none',
} as const;

export const zIndex = {
  // Layering policy. The codebase has 22 distinct numeric z-indexes; this
  // scale CONSOLIDATES them into 7 named layers. Map raw → named below.
  base:       0,
  raised:     1,    // 8 uses of `z-index: 1`
  sticky:     50,
  header:     100,  // nav bar / sticky header
  drawer:     200,  // sell-modal-backdrop, shopDashboard
  detail:     250,  // detail-backdrop
  modal:      300,  // modal-backdrop, verify-backdrop, info-backdrop
  toast:      400,  // toast
  bingoOverlay: 480, // bingo reveal layers (480/481/482)
  notification: 500,
  systemTop:    700, // crash overlay / critical
} as const;

/* -------------------------------------------------------------------------- */
/*  SEMANTIC ALIASES                                                          */
/* -------------------------------------------------------------------------- */

export const semantic = {
  bg: {
    page:        colors.surface.page,
    card:        colors.surface.card,
    chrome:      colors.surface.chrome,
    modalScrim:  colors.surface.scrim,
  },
  text: {
    primary:     colors.neutral.gray900,
    secondary:   colors.neutral.gray500,
    tertiary:    colors.neutral.gray400,
    onDark:      colors.neutral.white,
    onGold:      colors.brand.green900,
    link:        colors.brand.green600,
  },
  border: {
    subtle:      colors.neutral.gray200, // 1.5px solid var(--gray-200) appears 100+ times
    strong:      colors.neutral.gray300,
    focus:       colors.brand.green500,
  },
  state: {
    success:     colors.brand.green600,
    successBg:   '#e6f5ec',
    danger:      colors.status.danger,
    dangerBg:    colors.status.dangerBg,
    upTick:      colors.status.upGreen,
    downTick:    colors.status.danger,
    warning:     colors.gold.gold500,
  },
} as const;

/* -------------------------------------------------------------------------- */
/*  COMPONENT TOKENS                                                          */
/* -------------------------------------------------------------------------- */

export const components = {
  /**
   * BUTTON FAMILY
   * Canonical primary CTA: `.auth-btn` (index.html:1024).
   * Pill-shaped marketing CTA: `.btn-primary` (index.html:1252).
   * Pill outline on dark: `.btn-outline` (index.html:1254).
   * Sub-CTAs: `.btn-full.green`/`.btn-full.ghost` (index.html:1502-1505).
   * Compact list buttons: `.btn-buy`/`.btn-sell-sm` (index.html:1384).
   */
  button: {
    primary: {
      bg:        colors.brand.green600,
      bgHover:   colors.brand.green500,
      fg:        colors.neutral.white,
      paddingX:  spacing.xl,        // 12-13px
      paddingY:  spacing.xl + 1,    // 13px
      radius:    borderRadius.md,
      fontSize:  fontSizes.lg,      // 15px
      fontWeight: 700,
    },
    primaryPill: {
      bg:        colors.gold.gold400,
      bgHover:   colors.gold.gold300,
      fg:        colors.brand.green900,
      paddingX:  28,
      paddingY:  spacing.xl + 1,
      radius:    borderRadius.pill,
      fontSize:  fontSizes.lg,
      fontWeight: 600,
    },
    secondary: {
      bg:        colors.neutral.gray100,
      bgHover:   colors.neutral.white,
      fg:        colors.neutral.gray700,
      border:    `1.5px solid ${colors.neutral.gray200}`,
      paddingX:  spacing.xl,
      paddingY:  spacing.lg,
      radius:    borderRadius.md,
      fontSize:  fontSizes.md,
      fontWeight: 600,
    },
    ghostOnDark: {
      bg:        'transparent',
      bgHover:   colors.surface.overlayLight7,
      fg:        colors.neutral.white,
      border:    '1.5px solid rgba(255,255,255,0.3)',
      borderHover: 'rgba(255,255,255,0.7)',
      paddingX:  26,
      paddingY:  spacing.xl,
      radius:    borderRadius.pill,
      fontSize:  fontSizes.lg,
      fontWeight: 500,
    },
    danger: {
      bg:        colors.status.danger,
      fg:        colors.neutral.white,
      paddingX:  spacing.xl,
      paddingY:  spacing.xl + 1,
      radius:    borderRadius.md,
      fontSize:  fontSizes.lg,
      fontWeight: 700,
    },
    dangerSubtle: {
      bg:        'rgba(176,68,40,0.08)',
      fg:        '#b04428',
      border:    '1px solid rgba(176,68,40,0.3)',
    },
  },

  /**
   * INPUT FAMILY
   * Canonical: `.auth-input` (index.html:1020) — `1.5px solid var(--gray-200)`
   * + `border-radius: var(--radius-md)` + `padding: 12px 16px`.
   * Modal variant: `.modal-input-row input` (index.html:1499) uses 10px 14px.
   * Both should consume these tokens; 7+ inline duplicates exist (see audit).
   */
  input: {
    bg:           colors.neutral.white,
    fg:           colors.neutral.gray900,
    border:       `1.5px solid ${colors.neutral.gray200}`,
    borderFocus:  colors.brand.green500,
    radius:       borderRadius.md,
    paddingX:     spacing.xl,    // 12-16px (canonical 14)
    paddingY:     spacing.lg,    // 10-12px (canonical 10 for modal, 12 for auth)
    fontSize:     fontSizes.xl,  // 16px — also prevents iOS zoom
    fontFamily:   fontFamilies.body,
  },

  /**
   * CARD FAMILY
   * Canonical: `.product-card` (index.html:1279).
   * Uses radius-lg, 1px gray-200 border, white bg, --shadow-hover on hover.
   */
  card: {
    bg:           colors.surface.card,
    border:       `1px solid ${colors.neutral.gray200}`,
    borderHover:  colors.neutral.gray300,
    radius:       borderRadius.lg,
    shadowHover:  shadows.hover,
    padding:      spacing['3xl'], // 16px / 1rem
  },

  /**
   * MODAL FAMILY
   * Canonical backdrop: `.modal-backdrop` (index.html:1474) — z 300, scrim 0.6.
   * Canonical body: `.modal` (index.html:1476) — white, radius-xl, max 520px.
   * Header chrome dark green (index.html:1477).
   */
  modal: {
    backdrop: {
      bg:       colors.surface.scrim,
      z:        zIndex.modal,
      padding:  spacing['3xl'], // 1rem
    },
    surface: {
      bg:       colors.surface.card,
      radius:   borderRadius.xl,
      maxWidth: 520, // .modal=520, .verify=540, .sell=580, .detail=780. Use slot below.
    },
    sizes: { compact: 520, verify: 540, sell: 580, info: 720, detail: 780 },
    header: {
      bg:       colors.surface.chrome,
      paddingX: spacing['5xl'], // 1.5rem
      paddingY: 20,             // 1.25rem
      titleFontSize: fontSizes.xl + 3, // 1.2rem
      titleColor: colors.neutral.white,
      closeColor: 'rgba(255,255,255,0.6)',
    },
    body: { padding: spacing['5xl'] }, // 1.5rem
    footer: { gap: spacing.lg, paddingX: spacing['5xl'], paddingBottom: spacing['5xl'] },
  },

  /**
   * TOAST
   * Canonical: `.toast` (index.html:1789). Pinned bottom-center, pill radius,
   * z 400. Variant: `.toast.success` swaps bg to green-600.
   */
  toast: {
    bg:       colors.brand.green700,
    bgSuccess:colors.brand.green600,
    fg:       colors.neutral.white,
    paddingX: 28,
    paddingY: spacing['2xl'], // 14px
    radius:   borderRadius.pill,
    fontSize: fontSizes.lg,
    fontWeight: 600,
    z:        zIndex.toast,
    shadow:   shadows.toast,
    bottomOffset: spacing['6xl'], // 2rem
  },

  /**
   * PILL / CHIP FAMILY
   * Filter pill on dark hero: `.cat-pill` (index.html:1209). 50px radius.
   * Filter pill on light: `.condition-pill` (index.html:891). 50px radius.
   * Brand chip: `.brand-chip` (index.html:1368). 50px radius, green-700 bg.
   * Verified pill: `.verified-pill` (index.html:276). 999px radius. MERGE → pill.
   */
  pill: {
    radius:    borderRadius.pill,
    fontSize:  fontSizes.sm,    // 12-13px
    fontWeight: 600,
    paddingX:  spacing.xl,      // 12px
    paddingY:  spacing.sm - 1,  // 5px
    onDark: {
      bg:           colors.surface.overlayLight4,
      bgHover:      colors.surface.overlayLight12,
      bgActive:     colors.gold.gold400,
      fgActive:     colors.brand.green900,
      border:       '1px solid rgba(255,255,255,0.15)',
      borderHover:  'rgba(212,175,55,0.5)',
    },
    onLight: {
      bg:        colors.neutral.white,
      fg:        colors.neutral.gray700,
      border:    `1.5px solid ${colors.neutral.gray200}`,
      bgActive:  colors.brand.green600,
      fgActive:  colors.neutral.white,
    },
  },
} as const;

/* -------------------------------------------------------------------------- */
/*  TYPE EXPORTS                                                              */
/* -------------------------------------------------------------------------- */

export type Colors = typeof colors;
export type Spacing = typeof spacing;
export type FontSizes = typeof fontSizes;
export type BorderRadius = typeof borderRadius;
export type Shadows = typeof shadows;
export type ZIndex = typeof zIndex;
export type Components = typeof components;
