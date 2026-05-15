/**
 * functions/emails/layout/Base.jsx
 * ─────────────────────────────────────────────────────────────────────────
 * Shared layout for ALL TeeBox emails. Every template renders <Base/>
 * with content children. Base owns: hero header, body container, footer
 * (social row + company info + unsubscribe).
 *
 * NOTE: This file is .jsx — it requires a transpile step (esbuild / tsx /
 * babel) before Cloud Functions can require() it. See EMAIL_OPS_RUNBOOK.md
 * for the `npm run build:emails` step.
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

// Brand palette — must match index.html CSS custom props.
const GREEN_900 = "#0b3d2e";
const GREEN_950 = "#0b1a0e";
const GOLD_500 = "#d6a900";
const GOLD_300 = "#f0cc6a";
const GRAY_900 = "#111827";
const GRAY_700 = "#374151";
const GRAY_600 = "#4b5563";
const GRAY_500 = "#6b7280";
const GRAY_300 = "#d1d5db";
const WHITE = "#ffffff";
const PAGE_BG = "#f4f1ea";

const styles = {
  body: {
    backgroundColor: PAGE_BG,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    margin: 0,
    padding: 0,
    color: GRAY_900,
  },
  outer: {
    padding: "32px 16px",
  },
  container: {
    maxWidth: "560px",
    margin: "0 auto",
    backgroundColor: WHITE,
    borderRadius: "14px",
    overflow: "hidden",
    boxShadow: "0 4px 24px rgba(11, 26, 14, 0.08)",
  },
  header: {
    background: `linear-gradient(180deg, ${GREEN_950} 0%, ${GREEN_900} 100%)`,
    backgroundColor: GREEN_950,
    padding: "36px 24px 28px",
    textAlign: "center",
  },
  logo: {
    height: "72px",
    width: "72px",
    margin: "0 auto",
    display: "block",
  },
  brand: {
    color: GOLD_500,
    fontSize: "22px",
    fontWeight: "700",
    margin: "12px 0 0",
    letterSpacing: "4px",
    textTransform: "uppercase",
  },
  goldBar: {
    height: "3px",
    background: `linear-gradient(90deg, transparent 0%, ${GOLD_500} 50%, transparent 100%)`,
    margin: 0,
    border: 0,
  },
  bodyPad: {padding: "36px 32px 28px"},
  socialWrap: {
    padding: "20px 24px 4px",
    textAlign: "center",
    backgroundColor: "#fafaf7",
  },
  socialLabel: {
    fontSize: "11px",
    letterSpacing: "1.5px",
    textTransform: "uppercase",
    color: GRAY_500,
    margin: "0 0 10px",
    fontWeight: "600",
  },
  socialLink: {
    color: GREEN_900,
    fontSize: "13px",
    fontWeight: "600",
    textDecoration: "none",
    margin: "0 10px",
  },
  socialDot: {
    color: GOLD_500,
    fontSize: "13px",
  },
  footer: {
    padding: "16px 24px 24px",
    textAlign: "center",
    color: GRAY_500,
    fontSize: "12px",
    lineHeight: "18px",
    backgroundColor: "#fafaf7",
  },
  footerLink: {color: GRAY_700, textDecoration: "underline"},
};

/**
 * Props:
 *  - preview        Preview text (mobile inbox snippet). ≤ 90 chars.
 *  - uid            Recipient uid (required for unsubscribe link generation).
 *  - category       Category id (transactional => no unsubscribe link).
 *  - children       Body content.
 *  - hideHeader     Bool — for ultra-minimal security codes if ever needed.
 */
function Base({preview, uid, category = "transactional", children, hideHeader}) {
  const isTransactional = category === "transactional";
  const unsubUrl = isTransactional ? null : makeUnsubscribeUrl({uid, category});

  return (
    <Html>
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      {preview ? <Preview>{preview.slice(0, 90)}</Preview> : null}
      <Body style={styles.body}>
        <Section style={styles.outer}>
          <Container style={styles.container}>
            {!hideHeader && (
              <>
                <Section style={styles.header}>
                  <Link href={SITE_URL} style={{textDecoration: "none"}}>
                    <Img src={LOGO_URL} alt="TeeBox" style={styles.logo} />
                  </Link>
                  <Text style={styles.brand}>TeeBox</Text>
                </Section>
                <Hr style={styles.goldBar} />
              </>
            )}
            <Section style={styles.bodyPad}>{children}</Section>
            <Hr style={{borderColor: "#ece9e0", margin: 0}} />
            <Section style={styles.socialWrap}>
              <Text style={styles.socialLabel}>Follow TeeBox</Text>
              <Text style={{margin: "0 0 6px"}}>
                <Link href={IG_URL} style={styles.socialLink}>
                  Instagram · @teeboxmarket
                </Link>
                <span style={styles.socialDot}> • </span>
                <Link href={TIKTOK_URL} style={styles.socialLink}>
                  TikTok · @teeboxmarketplace
                </Link>
              </Text>
            </Section>
            <Section style={styles.footer}>
              <Text style={{margin: "0 0 6px", color: GRAY_700, fontWeight: "600"}}>
                {COMPANY_NAME}
              </Text>
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
                  <Link href={unsubUrl} style={styles.footerLink}>
                    Unsubscribe
                  </Link>{" "}
                  or{" "}
                  <Link
                    href="https://teeboxmarket.com/account?tab=email"
                    style={styles.footerLink}
                  >
                    manage preferences
                  </Link>
                  .
                </Text>
              ) : (
                <Text style={{margin: "0"}}>
                  This is a transactional message about your TeeBox account
                  and cannot be unsubscribed from.
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

/** Re-usable building blocks for child templates. */
function Button({href, children, color = GOLD_500, textColor = GREEN_950}) {
  return (
    <Section style={{textAlign: "center", margin: "28px 0 8px"}}>
      <Link
        href={href}
        style={{
          backgroundColor: color,
          color: textColor,
          padding: "14px 32px",
          borderRadius: "10px",
          fontWeight: "700",
          textDecoration: "none",
          display: "inline-block",
          fontSize: "15px",
          letterSpacing: "0.3px",
          boxShadow: "0 2px 6px rgba(214, 169, 0, 0.25)",
        }}
      >
        {children}
      </Link>
    </Section>
  );
}

function H1({children}) {
  return (
    <Heading
      as="h1"
      style={{
        fontSize: "24px",
        lineHeight: "30px",
        margin: "0 0 16px",
        color: GREEN_950,
        fontWeight: "700",
        letterSpacing: "-0.2px",
      }}
    >
      {children}
    </Heading>
  );
}

function P({children, muted}) {
  return (
    <Text
      style={{
        fontSize: "15px",
        lineHeight: "23px",
        margin: "0 0 14px",
        color: muted ? GRAY_600 : GRAY_700,
      }}
    >
      {children}
    </Text>
  );
}

module.exports = {Base, Button, H1, P};
