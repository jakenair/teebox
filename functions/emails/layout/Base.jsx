/**
 * functions/emails/layout/Base.jsx
 * ─────────────────────────────────────────────────────────────────────────
 * Shared layout for ALL TeeBox emails. Every template renders <Base/>
 * with content children. Base owns: logo header, body container, footer
 * (company name + physical address + unsubscribe link).
 *
 * NOTE: This file is .jsx — it requires a transpile step (esbuild / tsx /
 * babel) before Cloud Functions can require() it. See EMAIL_OPS_RUNBOOK.md
 * for the `npm run build:emails` step. We deliberately keep it JSX (not
 * tsx) to match the existing JS-only functions/ source set.
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
  Tailwind,
} = require("@react-email/components");
const {makeUnsubscribeUrl} = require("../../lib/email");

const COMPANY_NAME = "TeeBox, Inc.";
const COMPANY_ADDRESS = "1234 Fairway Ln, Suite 200, Chicago, IL 60601, USA";
const SUPPORT_EMAIL = "support@teeboxmarket.com";
const LOGO_URL = "https://teeboxmarket.com/icon-192.png";

// Brand palette — must match index.html CSS custom props.
const GREEN_900 = "#0b3d2e";
const GOLD_500 = "#d6a900";
const GRAY_900 = "#111827";
const GRAY_600 = "#4b5563";
const GRAY_400 = "#9ca3af";
const WHITE = "#ffffff";
const PAGE_BG = "#f5f7f6";

const styles = {
  body: {
    backgroundColor: PAGE_BG,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    margin: 0,
    padding: 0,
    color: GRAY_900,
  },
  container: {
    maxWidth: "600px",
    margin: "0 auto",
    backgroundColor: WHITE,
    borderRadius: "8px",
    overflow: "hidden",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  header: {
    backgroundColor: GREEN_900,
    padding: "20px 24px",
    textAlign: "center",
  },
  logo: {
    height: "36px",
    width: "36px",
    margin: "0 auto",
  },
  brand: {
    color: GOLD_500,
    fontSize: "18px",
    fontWeight: "700",
    margin: "8px 0 0",
    letterSpacing: "0.5px",
  },
  bodyPad: {padding: "32px 24px"},
  footer: {
    padding: "24px",
    textAlign: "center",
    color: GRAY_400,
    fontSize: "12px",
    lineHeight: "18px",
    backgroundColor: "#fafbfb",
  },
  footerLink: {color: GRAY_600, textDecoration: "underline"},
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
        <Container style={styles.container}>
          {!hideHeader && (
            <Section style={styles.header}>
              <Img src={LOGO_URL} alt="TeeBox" style={styles.logo} />
              <Text style={styles.brand}>TEEBOX</Text>
            </Section>
          )}
          <Section style={styles.bodyPad}>{children}</Section>
          <Hr style={{borderColor: "#e5e7eb", margin: 0}} />
          <Section style={styles.footer}>
            <Text style={{margin: "0 0 8px"}}>
              {COMPANY_NAME} · {COMPANY_ADDRESS}
            </Text>
            <Text style={{margin: "0 0 8px"}}>
              Questions?{" "}
              <Link href={`mailto:${SUPPORT_EMAIL}`} style={styles.footerLink}>
                {SUPPORT_EMAIL}
              </Link>
            </Text>
            {!isTransactional && unsubUrl ? (
              <Text style={{margin: "0"}}>
                You received this because you opted in to TeeBox {prettyCategory(category)} email.{" "}
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
function Button({href, children, color = GOLD_500, textColor = GREEN_900}) {
  return (
    <Section style={{textAlign: "center", margin: "24px 0"}}>
      <Link
        href={href}
        style={{
          backgroundColor: color,
          color: textColor,
          padding: "12px 28px",
          borderRadius: "6px",
          fontWeight: "700",
          textDecoration: "none",
          display: "inline-block",
          fontSize: "15px",
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
      style={{fontSize: "22px", margin: "0 0 16px", color: GRAY_900}}
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
        lineHeight: "22px",
        margin: "0 0 12px",
        color: muted ? GRAY_600 : GRAY_900,
      }}
    >
      {children}
    </Text>
  );
}

module.exports = {Base, Button, H1, P};
