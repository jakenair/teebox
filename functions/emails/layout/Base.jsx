/**
 * functions/emails/layout/Base.jsx
 * ─────────────────────────────────────────────────────────────────────────
 * Shared layout for ALL TeeBox emails. Every template renders <Base/>
 * with content children. Base owns: masthead, body container, footer.
 *
 * Design (2026-09-04 redesign): the app's own type system — Playfair Display
 * headlines (Georgia fallback where a client strips web fonts, e.g. Gmail),
 * DM Sans body — a slim left-set pine masthead with the real TeeBox mark,
 * a restrained cream/white/pine/gold palette, and one gold accent per email.
 * Reusable blocks: Button, H1, P, plus ProductRow / Receipt / ReceiptRow /
 * Amount for order + payout templates.
 *
 * NOTE: .jsx — requires the esbuild transpile (`npm run build:emails`)
 * before Cloud Functions can require() it. See EMAIL_OPS_RUNBOOK.md.
 */

const React = require("react");
const {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Row,
  Column,
  Img,
  Text,
  Heading,
  Link,
  Hr,
} = require("@react-email/components");
const {makeUnsubscribeUrl} = require("../../lib/email");

const COMPANY_NAME = "TeeBox, Inc.";
const COMPANY_ADDRESS = "16649 Oak Park Ave, Ste H #1160, Tinley Park, IL 60477, USA";
const SUPPORT_EMAIL = "support@teeboxmarket.com";
const LOGO_URL = "https://teeboxmarket.com/email-logo.png";
const SITE_URL = "https://teeboxmarket.com";
const IG_URL = "https://instagram.com/teeboxmarket";
const TIKTOK_URL = "https://tiktok.com/@teeboxmarketplace";

// ── Palette (matches index.html brand tokens; gold deepened for print-weight) ──
const PINE = "#0b3d2e";
const PINE_DEEP = "#06231a";
const GOLD = "#b7871a";        // single accent — deeper than the neon web gold
const GOLD_SOFT = "#c99a2b";   // wordmark / on-dark
const INK = "#17241c";         // primary text on white
const MOSS = "#66716a";        // secondary text on white
const CARD = "#ffffff";
const PAGE_BG = "#efeadf";      // warm cream ground
const HAIR = "#ecebe3";        // hairline on white
const FILL = "#f6f4ed";        // subtle fill blocks
const GOOD = "#2f7d52";

// ── Type stacks (Playfair→Georgia, DM Sans→system) ──
const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const SANS =
  "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const styles = {
  body: {
    backgroundColor: PAGE_BG,
    fontFamily: SANS,
    margin: 0,
    padding: 0,
    color: INK,
  },
  outer: {padding: "32px 16px"},
  container: {
    maxWidth: "600px",
    margin: "0 auto",
    backgroundColor: CARD,
    borderRadius: "16px",
    overflow: "hidden",
    boxShadow: "0 1px 2px rgba(11,35,26,.06), 0 14px 40px rgba(11,35,26,.10)",
  },
  header: {
    background: `linear-gradient(180deg, ${PINE} 0%, ${PINE_DEEP} 100%)`,
    backgroundColor: PINE,
    padding: "20px 30px",
  },
  logo: {
    width: "30px",
    height: "30px",
    borderRadius: "7px",
    display: "block",
  },
  wordmark: {
    fontFamily: SERIF,
    fontWeight: "700",
    fontSize: "21px",
    color: "#f4efe1",
    margin: 0,
    lineHeight: "30px",
  },
  wordmarkGold: {color: GOLD_SOFT},
  goldline: {height: "2px", backgroundColor: GOLD, border: 0, margin: 0, opacity: 0.9},
  bodyPad: {padding: "34px 34px 12px"},
  socialWrap: {padding: "22px 30px 6px", textAlign: "center", backgroundColor: "#faf8f2"},
  socialLink: {color: PINE, fontSize: "13px", fontWeight: "600", textDecoration: "none", margin: "0 8px"},
  socialDot: {color: GOLD, fontSize: "13px"},
  footer: {
    padding: "10px 30px 26px",
    textAlign: "center",
    color: "#9aa196",
    fontSize: "11.5px",
    lineHeight: "18px",
    backgroundColor: "#faf8f2",
  },
  footerName: {margin: "0 0 4px", color: MOSS, fontWeight: "600", fontSize: "12.5px"},
  footerLink: {color: MOSS, textDecoration: "underline"},
};

/**
 * Props:
 *  - preview     Inbox snippet (≤ 90 chars).
 *  - uid         Recipient uid (required for unsubscribe on marketing mail).
 *  - category    Category id ("transactional" => no unsubscribe link).
 *  - children    Body content.
 *  - hideHeader  Ultra-minimal (e.g. 2FA codes) — no masthead.
 */
function Base({preview, uid, category = "transactional", children, hideHeader}) {
  const isTransactional = category === "transactional";
  const unsubUrl = isTransactional ? null : makeUnsubscribeUrl({uid, category});

  return (
    <Html>
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
        {/* Honored by Apple Mail / iOS Mail; Gmail & Outlook fall back to
            Georgia / system sans via the font stacks above. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap"
        />
      </Head>
      {preview ? <Preview>{preview.slice(0, 90)}</Preview> : null}
      <Body style={styles.body}>
        <Section style={styles.outer}>
          <Container style={styles.container}>
            {!hideHeader && (
              <>
                <Section style={styles.header}>
                  <Row>
                    <Column style={{width: "38px", verticalAlign: "middle"}}>
                      <Link href={SITE_URL}>
                        <Img src={LOGO_URL} alt="TeeBox" style={styles.logo} />
                      </Link>
                    </Column>
                    <Column style={{verticalAlign: "middle"}}>
                      <Text style={styles.wordmark}>
                        Tee<span style={styles.wordmarkGold}>Box</span>
                      </Text>
                    </Column>
                  </Row>
                </Section>
                <Hr style={styles.goldline} />
              </>
            )}
            <Section style={styles.bodyPad}>{children}</Section>
            <Hr style={{borderColor: HAIR, margin: 0}} />
            <Section style={styles.socialWrap}>
              <Text style={{margin: 0}}>
                <Link href={IG_URL} style={styles.socialLink}>Instagram</Link>
                <span style={styles.socialDot}>·</span>
                <Link href={TIKTOK_URL} style={styles.socialLink}>TikTok</Link>
              </Text>
            </Section>
            <Section style={styles.footer}>
              <Text style={styles.footerName}>{COMPANY_NAME}</Text>
              <Text style={{margin: "0 0 8px"}}>{COMPANY_ADDRESS}</Text>
              <Text style={{margin: "0 0 10px"}}>
                Questions?{" "}
                <Link href={`mailto:${SUPPORT_EMAIL}`} style={styles.footerLink}>
                  {SUPPORT_EMAIL}
                </Link>
              </Text>
              {!isTransactional && unsubUrl ? (
                <Text style={{margin: "0"}}>
                  You received this because you opted in to TeeBox{" "}
                  {prettyCategory(category)} email.{" "}
                  <Link href={unsubUrl} style={styles.footerLink}>Unsubscribe</Link>{" "}
                  or{" "}
                  <Link href="https://teeboxmarket.com/account?tab=email" style={styles.footerLink}>
                    manage preferences
                  </Link>.
                </Text>
              ) : (
                <Text style={{margin: "0"}}>
                  A transactional message about your TeeBox account.
                </Text>
              )}
            </Section>
          </Container>
        </Section>
      </Body>
    </Html>
  );
}

function prettyCategory(c) {
  return (
    {
      savedSearchMatches: "saved-search",
      priceDrops: "price-drop",
      abandonedDraft: "abandoned-draft",
      abandonedCart: "abandoned-cart",
      reviewRequests: "review-request",
      winBack: "we-miss-you",
      weeklyDigest: "weekly digest",
      productUpdates: "product update",
    }[c] || "marketing"
  );
}

// ── Reusable building blocks ──────────────────────────────────────────────

/** Primary CTA — one gold button per email, no shadow/gradient. */
function Button({href, children, variant = "solid"}) {
  const solid = variant === "solid";
  return (
    <Section style={{textAlign: "center", margin: "26px 0 6px"}}>
      <Link
        href={href}
        style={{
          backgroundColor: solid ? GOLD : "transparent",
          color: solid ? "#231704" : PINE,
          border: solid ? "none" : `1.5px solid ${HAIR}`,
          padding: solid ? "14px 34px" : "12px 30px",
          borderRadius: "10px",
          fontWeight: "700",
          textDecoration: "none",
          display: "inline-block",
          fontSize: "15px",
          letterSpacing: "0.2px",
        }}
      >
        {children}
      </Link>
    </Section>
  );
}

/** Playfair headline. */
function H1({children}) {
  return (
    <Heading
      as="h1"
      style={{
        fontFamily: SERIF,
        fontSize: "27px",
        lineHeight: "1.14",
        margin: "0 0 12px",
        color: INK,
        fontWeight: "700",
        letterSpacing: "-0.2px",
      }}
    >
      {children}
    </Heading>
  );
}

/** Uppercase gold kicker above a headline. */
function Kicker({children}) {
  return (
    <Text
      style={{
        fontFamily: SANS,
        fontSize: "11.5px",
        fontWeight: "600",
        letterSpacing: "1.8px",
        textTransform: "uppercase",
        color: GOLD,
        margin: "0 0 12px",
      }}
    >
      {children}
    </Text>
  );
}

function P({children, muted}) {
  return (
    <Text
      style={{
        fontFamily: SANS,
        fontSize: "15px",
        lineHeight: "1.6",
        margin: "0 0 18px",
        color: muted ? MOSS : "#3a4640",
      }}
    >
      {children}
    </Text>
  );
}

/** Product row: photo + name + description (+ optional price). */
function ProductRow({imageUrl, name, desc, price}) {
  return (
    <Section
      style={{
        border: `1px solid ${HAIR}`,
        borderRadius: "12px",
        backgroundColor: "#fcfbf7",
        padding: "14px",
        margin: "20px 0",
      }}
    >
      <Row>
        {imageUrl ? (
          <Column style={{width: "92px", verticalAlign: "middle"}}>
            <Img
              src={imageUrl}
              alt={name || ""}
              style={{width: "78px", height: "78px", borderRadius: "9px", objectFit: "cover"}}
            />
          </Column>
        ) : null}
        <Column style={{verticalAlign: "middle"}}>
          <Text style={{margin: 0, fontFamily: SANS, fontSize: "15px", fontWeight: "600", color: INK, lineHeight: "1.3"}}>
            {name}
          </Text>
          {desc ? (
            <Text style={{margin: "3px 0 0", fontFamily: SANS, fontSize: "13px", color: MOSS}}>
              {desc}
            </Text>
          ) : null}
        </Column>
        {price ? (
          <Column style={{width: "72px", verticalAlign: "middle", textAlign: "right"}}>
            <Text
              style={{
                margin: 0,
                fontFamily: SERIF,
                fontSize: "19px",
                fontWeight: "600",
                color: INK,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {price}
            </Text>
          </Column>
        ) : null}
      </Row>
    </Section>
  );
}

/** One line in a Receipt. `strong` renders the total row. */
function ReceiptRow({label, value, negative, strong}) {
  return (
    <Row style={strong ? {borderTop: `1px solid ${HAIR}`} : null}>
      <Column style={{padding: strong ? "13px 2px 4px" : "8px 2px"}}>
        <Text
          style={{
            margin: 0,
            fontFamily: SANS,
            fontSize: strong ? "15px" : "14.5px",
            fontWeight: strong ? "600" : "400",
            color: strong ? INK : MOSS,
          }}
        >
          {label}
        </Text>
      </Column>
      <Column style={{padding: strong ? "13px 2px 4px" : "8px 2px", textAlign: "right"}}>
        <Text
          style={{
            margin: 0,
            fontFamily: strong ? SERIF : SANS,
            fontSize: strong ? "20px" : "14.5px",
            fontWeight: strong ? "700" : "500",
            color: negative ? MOSS : INK,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </Text>
      </Column>
    </Row>
  );
}

/** Receipt container — wrap ReceiptRow children. */
function Receipt({children}) {
  return <Section style={{margin: "22px 0 4px"}}>{children}</Section>;
}

/** Big centered figure (payout / refund amount) with a label + subline. */
function Amount({label, value, sub}) {
  return (
    <Section
      style={{
        textAlign: "center",
        borderTop: `1px solid ${HAIR}`,
        borderBottom: `1px solid ${HAIR}`,
        margin: "8px 0 22px",
        padding: "18px 0",
      }}
    >
      <Text style={{margin: "0 0 4px", fontFamily: SANS, fontSize: "11.5px", letterSpacing: "1.4px", textTransform: "uppercase", color: MOSS, fontWeight: "600"}}>
        {label}
      </Text>
      <Text style={{margin: "0 0 6px", fontFamily: SERIF, fontSize: "50px", fontWeight: "800", color: GOLD, lineHeight: "1", fontVariantNumeric: "tabular-nums"}}>
        {value}
      </Text>
      {sub ? (
        <Text style={{margin: 0, fontFamily: SANS, fontSize: "13px", color: MOSS}}>{sub}</Text>
      ) : null}
    </Section>
  );
}

/** Address / labeled info block. */
function InfoBlock({label, children}) {
  return (
    <Section style={{margin: "20px 0", padding: "16px 18px", borderRadius: "11px", backgroundColor: FILL, border: `1px solid ${HAIR}`}}>
      <Text style={{margin: "0 0 7px", fontFamily: SANS, fontSize: "11px", letterSpacing: "1.3px", textTransform: "uppercase", fontWeight: "600", color: MOSS}}>
        {label}
      </Text>
      <Text style={{margin: 0, fontFamily: SANS, fontSize: "14.5px", color: INK, lineHeight: "1.5"}}>
        {children}
      </Text>
    </Section>
  );
}

/** Next-step callout with a green status dot. */
function NextStep({children}) {
  return (
    <Section style={{margin: "20px 0", padding: "16px 18px", borderRadius: "11px", backgroundColor: "#eef4ef", border: "1px solid #d9e6dd"}}>
      <Row>
        <Column style={{width: "18px", verticalAlign: "top"}}>
          <div style={{width: "8px", height: "8px", borderRadius: "50%", backgroundColor: GOOD, marginTop: "6px"}} />
        </Column>
        <Column>
          <Text style={{margin: 0, fontFamily: SANS, fontSize: "14px", color: "#20452f", lineHeight: "1.5"}}>
            {children}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}

module.exports = {
  Base, Button, H1, P, Kicker,
  ProductRow, Receipt, ReceiptRow, Amount, InfoBlock, NextStep,
};
