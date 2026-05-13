# TeeBox — DNS Records Checklist (`teeboxmarket.com`)

Copy-paste-ready records for Squarespace DNS. All sending goes through
`mail.teeboxmarket.com`; the apex stays locked down with hardline SPF +
DMARC `p=reject`.

---

## Section 1 — Records at the apex domain (`teeboxmarket.com`)

| Type | Host/Name | Value | TTL | What it does | What fails without it |
|---|---|---|---|---|---|
| TXT | `@` | `v=spf1 -all` | 3600 | Declares the apex sends NO mail. Any IP claiming to be `support@teeboxmarket.com` fails SPF. | Spoofers can impersonate `support@teeboxmarket.com` and recipient filters won't catch it. |
| TXT | `_dmarc` | `v=DMARC1; p=reject; rua=mailto:dmarc@mail.teeboxmarket.com` | 3600 | Tells receivers to reject any unauthenticated mail from `teeboxmarket.com`, and where to send aggregate reports. | Phishing of the brand goes undetected; no visibility into spoof attempts. |
| MX | `@` | `mx1.improvmx.com` (priority 10) | 3600 | Routes inbound mail for `support@`, `legal@`, `press@`, `hello@`, `jake@` to ImprovMX, which forwards to your real inbox. | All inbound mail to any `@teeboxmarket.com` address bounces. |
| MX | `@` | `mx2.improvmx.com` (priority 20) | 3600 | Backup ImprovMX MX. Used if `mx1` is unreachable. | Single point of failure for inbound mail; transient outages cause bounces. |

> If you choose Cloudflare Email Routing instead of ImprovMX, swap the
> two MX rows for the three Cloudflare MX records the CF dashboard
> shows you (`route1.mx.cloudflare.net`, `route2…`, `route3…`).

---

## Section 2 — Records at `mail.teeboxmarket.com` (sending subdomain)

| Type | Host/Name | Value | TTL | What it does | What fails without it |
|---|---|---|---|---|---|
| TXT | `mail` | `v=spf1 include:_spf.resend.com -all` | 3600 | Authorises Resend's outbound IPs to send mail as `*@mail.teeboxmarket.com`. | Resend mail fails SPF → lands in spam or rejected. |
| CNAME | `resend._domainkey.mail` | `<copy from Resend dashboard after adding domain there>` | 3600 | Publishes Resend's DKIM public key so recipients can verify the signature on outbound mail. | All transactional mail unsigned → Gmail "Show original" shows DKIM=missing → spam folder. |
| TXT | `_dmarc.mail` | `v=DMARC1; p=quarantine; pct=10; rua=mailto:dmarc@mail.teeboxmarket.com; ruf=mailto:dmarc@mail.teeboxmarket.com; fo=1; aspf=s; adkim=s` | 3600 | DMARC policy for the sending subdomain. Starts at quarantine/10% and ramps per the schedule in `EMAIL_DNS_SETUP.md`. | Fails Gmail/Yahoo Feb-2024 bulk-sender requirements; lower inbox placement. |
| CNAME | `<resend-return-path>.mail` | `<copy from Resend dashboard>` | 3600 | Optional Resend "managed Return-Path" CNAME for bounce/FBL handling. Only publish if Resend's dashboard lists it. | Bounce handling falls back to Resend's shared return-path; FBL reports may be less precise. |

> Resend may give you 1–3 DKIM CNAMEs (e.g. `resend._domainkey.mail`,
> `resend2._domainkey.mail`, …). Publish every row the dashboard shows
> exactly as given.

---

## Section 3 — Copy-paste-ready Squarespace steps

1. Go to `account.squarespace.com` → Domains → `teeboxmarket.com` → DNS Settings.
2. Scroll to **Custom Records**.
3. For each row in Sections 1 and 2 above, click **Add Record**:
   - Set **Type** (TXT / MX / CNAME).
   - Set **Host** exactly as written (`@`, `mail`, `_dmarc`, `_dmarc.mail`, `resend._domainkey.mail`).
   - Set **Data / Value** exactly as written (with quotes for TXT values if Squarespace requires them — most don't).
   - For MX rows, set **Priority** (10 or 20).
   - Leave TTL at the default (Squarespace uses 4 hours) unless you can override to 3600.
   - Click **Save**.
4. Repeat until all 8 records (4 apex + 4 sending-subdomain) are saved.
5. Confirm the records list shows all of them with no red error icons.
6. Leave the page open for ~5 minutes and refresh — Squarespace sometimes silently rejects malformed TXT values.

---

## Section 4 — Verification commands

After publishing, from a terminal:

```bash
dig +short MX teeboxmarket.com                               # expect mx1/mx2.improvmx.com
dig +short TXT teeboxmarket.com                              # expect v=spf1 -all
dig +short TXT _dmarc.teeboxmarket.com                       # expect p=reject
dig +short TXT mail.teeboxmarket.com                         # expect _spf.resend.com
dig +short CNAME resend._domainkey.mail.teeboxmarket.com     # expect a long Resend host
dig +short TXT _dmarc.mail.teeboxmarket.com                  # expect p=quarantine
```

Web double-check:
- `mxtoolbox.com/SPFRecordLookup.aspx?domain=mail.teeboxmarket.com` — green check.
- `dmarcian.com/dmarc-inspector/?domain=teeboxmarket.com` — should show `p=reject`.
- Resend dashboard → Domains → `mail.teeboxmarket.com` → all rows green.
- ImprovMX dashboard → `teeboxmarket.com` → MX status green.

---

## Section 5 — Order matters

1. **ImprovMX signup** first. Create the account, add `teeboxmarket.com`, set up the 5 forwarders (`support@`, `legal@`, `press@`, `hello@`, `jake@` → your real inbox). This gives you the MX values to publish.
2. **Resend signup** + add `mail.teeboxmarket.com` as a domain. Resend's dashboard will show you the exact DKIM CNAME target(s) and any return-path CNAME.
3. **Publish all DNS at once in Squarespace** (Sections 1 + 2 above). Doing it in one pass means a single propagation wait.
4. **Wait 5–30 minutes** for propagation. Some Squarespace zones take longer.
5. **Click "Verify" in Resend** — DKIM/SPF/DMARC rows should turn green.
6. **Click "Verify" in ImprovMX** — MX status should turn green.
7. **Run the `dig` commands** in Section 4 to confirm independently.
8. Send a test email via Resend to a Gmail address; check **Show original** — `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
9. Send a test inbound to `support@teeboxmarket.com` from an external address; confirm it lands in your real inbox via the ImprovMX forwarder.

---

## Section 6 — Things that will fail if any record is missing

- **Without apex SPF + DMARC `p=reject`**: anyone can spoof `support@teeboxmarket.com` phishing emails. Recipients' filters won't catch it.
- **Without `mail.` SPF**: Resend can't send authenticated email; all email lands in spam.
- **Without `mail.` DKIM**: same as above, plus Gmail's "Show original" will show DKIM=missing.
- **Without `mail.` DMARC**: Gmail/Yahoo bulk-sender requirements (effective Feb 2024) fail; deliverability tanks.
- **Without MX**: ALL inbound mail to any `@teeboxmarket.com` address bounces. Currently impacted: 5 canonical addresses (`support@`, `legal@`, `press@`, `hello@`, `jake@`).
- **Without DKIM CNAME from Resend**: emails get sent but unsigned → likely spam folder.
