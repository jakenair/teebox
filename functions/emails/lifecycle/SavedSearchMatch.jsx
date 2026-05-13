/**
 * SavedSearchMatch — FULLY BUILT
 * Batched. Throttled 1x/24h per user per saved-search id.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Row, Column, Text, Img, Link} = require("@react-email/components");

function SavedSearchMatch({user = {}, search = {}, matches = []}) {
  const safeMatches = matches.slice(0, 6);
  const searchUrl = `https://teeboxmarket.com/search?q=${encodeURIComponent(
      search.query || "",
  )}`;

  return (
    <Base
      preview={`${safeMatches.length} new ${
        safeMatches.length === 1 ? "match" : "matches"
      } for "${search.query || "your saved search"}".`}
      uid={user.uid}
      category="savedSearchMatches"
    >
      <H1>New matches for "{search.query || "your search"}"</H1>
      <P>
        Hi {user.firstName || "golfer"} — {safeMatches.length}{" "}
        {safeMatches.length === 1 ? "listing matches" : "listings match"} your
        saved search.
      </P>

      {safeMatches.map((m, i) => (
        <Section
          key={m.id || i}
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "6px",
            padding: "12px",
            margin: "0 0 12px",
          }}
        >
          <Row>
            {m.imageUrl ? (
              <Column style={{width: "84px"}}>
                <Img
                  src={m.imageUrl}
                  alt={m.title}
                  style={{
                    width: "72px",
                    height: "72px",
                    borderRadius: "4px",
                    objectFit: "cover",
                  }}
                />
              </Column>
            ) : null}
            <Column>
              <Text style={{margin: 0, fontWeight: "600", fontSize: "15px"}}>
                <Link
                  href={`https://teeboxmarket.com/listing/${m.id}`}
                  style={{color: "#0b3d2e", textDecoration: "none"}}
                >
                  {m.title}
                </Link>
              </Text>
              <Text style={{margin: "4px 0 0", fontSize: "14px", color: "#6b7280"}}>
                ${(Number(m.priceCents || 0) / 100).toFixed(2)} ·{" "}
                {m.condition || "—"}
              </Text>
            </Column>
          </Row>
        </Section>
      ))}

      <Button href={searchUrl}>See all matches</Button>
    </Base>
  );
}

module.exports = SavedSearchMatch;
module.exports.subject = (ctx) => {
  const n = (ctx.matches || []).length;
  const q = (ctx.search && ctx.search.query) || "your search";
  return `${n} new for "${q}"`.slice(0, 50);
};
