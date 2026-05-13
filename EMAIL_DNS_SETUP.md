# TeeBox Email — DNS Setup

All sending goes through the **`mail.teeboxmarket.com`** subdomain — keeps
the apex domain's reputation isolated from marketing traffic and lets us
nuke / rotate the sending subdomain without touching the website.

Resend dashboard → Domains → Add `mail.teeboxmarket.com` → it will show
you DKIM CNAME + a Resend-managed Return-Path. Use the values below as a
template — Resend will tell you the exact DKIM selector names to use.

---

## Paste-ready DNS records

> Use `@` for "this host". For records that target `mail.teeboxmarket.com`,
> set Host = `mail` at the apex zone (most registrars).

```txt
;;
;; SPF — authorise Resend's outbound IPs to send for mail.teeboxmarket.com
;;
mail            IN  TXT   "v=spf1 include:_spf.resend.com -all"

;;
;; DKIM — Resend will give you 1–3 CNAMEs in the dashboard. The selector
;; names (resend._domainkey, resend2._domainkey, …) come from the dashboard.
;; Replace <RESEND-DKIM-HOST> with the value Resend shows.
;;
resend._domainkey.mail   IN  CNAME  <RESEND-DKIM-HOST>.resend.com.

;;
;; DMARC — start at quarantine/pct=10 for 7 days, ramp to pct=100, then
;; switch to p=reject after 30 days of clean reports. Aggregates go to
;; dmarc@mail.teeboxmarket.com (set up a mailbox or forward to a Postmark /
;; Dmarcian aggregator).
;;
_dmarc.mail     IN  TXT   "v=DMARC1; p=quarantine; pct=10; rua=mailto:dmarc@mail.teeboxmarket.com; ruf=mailto:dmarc@mail.teeboxmarket.com; fo=1; aspf=s; adkim=s"

;;
;; MX — only needed if you want Resend's inbound (bounce / FBL) at the
;; sending subdomain. Resend handles return-path mailbox automatically
;; if you configure their "managed Return-Path" toggle, in which case
;; you don't need an MX on `mail`.
;;
;; (optional) mail   IN MX 10 feedback-smtp.us-east-1.amazonses.com.

;;
;; BIMI — only after p=quarantine with 100% enforcement is stable for 30
;; days. Logo must be SVG-tiny + VMC certificate. Defer for now.
;;
;; default._bimi.mail IN TXT "v=BIMI1; l=https://teeboxmarket.com/brand/bimi.svg; a=https://teeboxmarket.com/brand/vmc.pem"
```

### Apex domain (`teeboxmarket.com`) — keep these too

If you don't send anything from the apex right now, publish a hardline
SPF + DMARC so spoofers can't ride the brand:

```txt
@               IN  TXT   "v=spf1 -all"
_dmarc          IN  TXT   "v=DMARC1; p=reject; rua=mailto:dmarc@mail.teeboxmarket.com"
```

---

## DMARC ramp schedule

| Day | Policy | Pct | Note |
|-----|--------|-----|------|
| 0   | `p=quarantine` | `pct=10` | Initial cutover. Watch the rua reports. |
| 7   | `p=quarantine` | `pct=50` | If aggregate pass rate > 98%, advance. |
| 14  | `p=quarantine` | `pct=100` | All non-aligned mail to spam. |
| 30  | `p=reject` | `pct=100` | Final state. Hold here unless aggregates degrade. |

Roll back to the previous step at any sign of legitimate mail being
quarantined (check rua aggregates daily for the first 30 days).

---

## Verification

After publishing, verify with:

```bash
dig +short TXT mail.teeboxmarket.com               # SPF
dig +short CNAME resend._domainkey.mail.teeboxmarket.com   # DKIM
dig +short TXT _dmarc.mail.teeboxmarket.com        # DMARC
```

Then in Resend → Domains → click **Verify**. All three checks should
turn green. Without a green DKIM, every email lands in spam.

---

## DMARC aggregator inbox

Create `dmarc@mail.teeboxmarket.com` as a forwarder. Recommended free
aggregators: Postmark DMARC, Dmarcian Community, Valimail Monitor.
Aggregator inboxes parse the daily XML rolls and surface alignment
issues in a UI.

---

## Sender identity records (for inbox / FBL completeness)

```txt
;; Canonical role mailboxes at teeboxmarket.com (real forwarders, not DNS):
;; support@teeboxmarket.com   customer support, billing, abuse, security,
;;                            disputes, appeals, account-takeover, RFC 2142
;; legal@teeboxmarket.com     privacy, terms, DMCA agent, copyright, IP/counterfeit
;; press@teeboxmarket.com     press kit, media inquiries
;; hello@teeboxmarket.com     general inbound, partnerships
;; jake@teeboxmarket.com      founder bio, personal outreach
;;
;; Sending-subdomain mailboxes at mail.teeboxmarket.com:
;; noreply@mail.teeboxmarket.com       From address on transactional email
;; unsubscribe@mail.teeboxmarket.com   List-Unsubscribe mailto target (RFC 8058)
;; dmarc@mail.teeboxmarket.com         DMARC aggregator inbox
```
