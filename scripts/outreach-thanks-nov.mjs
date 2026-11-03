#!/usr/bin/env node
// thanks_nov founder email — "Thank you for being early" + one ask to list.
// Plain, personal, from Jake. Nothing sends without an explicit flag.
//
//   node scripts/outreach-thanks-nov.mjs --render <outDir>          # write sample HTML (no sends)
//   node scripts/outreach-thanks-nov.mjs --test-to <email> --uid <uid>   # ONE test send
//   node scripts/outreach-thanks-nov.mjs --send --audience <file.json> --offset 0 --limit 20
//
// Real sends go through functions/lib/email.js sendEmail with category
// productUpdates (marketing): the shared preflight enforces suppression,
// marketingConsent.granted === true, pauses and per-category opt-out, adds the
// RFC 8058 List-Unsubscribe headers and logs every send to emailSends/.
//
// Env: RESEND_API_KEY + UNSUBSCRIBE_HMAC_SECRET (from Secret Manager), and
// NODE_PATH=functions/node_modules.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: "teebox-market" });
const email = require("../functions/lib/email.js");

const FROM = "Jake Nair <jakenair@mail.teeboxmarket.com>";
const REPLY_TO = "support@teeboxmarket.com";
const SUBJECT = "Thank you for being early";
const CTA = "https://teeboxmarket.com/?action=sell&utm_source=email&utm_medium=email&utm_campaign=thanks_nov";
const ADDRESS = "TeeBox Market LLC · 16649 Oak Park Ave, Ste H #1160, Tinley Park, IL 60477, USA";
const CATEGORY = email.CATEGORIES.PRODUCT_UPDATES;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// A display name is used only when it looks like a real first name.
function firstName(raw) {
  const f = String(raw || "").trim().split(/\s+/)[0] || "";
  return /^[A-Za-z][A-Za-z'’-]{1,19}$/.test(f) ? f[0].toUpperCase() + f.slice(1) : "";
}

export function render({ first, streak, unsubUrl }) {
  const hello = first ? `Hey ${esc(first)},` : "Hey there,";
  const streakLine = streak >= 3
    ? `Your Logo Bingo streak is ${streak} days. That's better than mine.`
    : "";
  const p = (t) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#1f2a22;">${t}</p>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${SUBJECT}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:560px;margin:0 auto;padding:28px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
${p(hello)}
${p("I'm Jake. I started TeeBox this year, and you're one of the first people using it. Thank you, genuinely.")}
${streakLine ? p(esc(streakLine)) : ""}
${p("One ask: if you've got a club, putter or bag you're not using, list it on TeeBox. Snap a photo and set a price; Caddie writes the rest. It takes about two minutes.")}
<p style="margin:8px 0 24px;"><a href="${CTA}" style="display:inline-block;background:#2d5a3d;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">List something</a></p>
${p("Jake<br><span style=\"color:#6b726c;font-size:14px;\">Founder, TeeBox</span>")}
<hr style="border:none;border-top:1px solid #e6e8e4;margin:28px 0 14px;">
<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#8a908b;">You're getting this because you have a TeeBox account. <a href="${esc(unsubUrl)}" style="color:#8a908b;">Unsubscribe</a> from emails like this.</p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#8a908b;">${ADDRESS}</p>
</div></body></html>`;
  const text = [hello, "",
    "I'm Jake. I started TeeBox this year, and you're one of the first people using it. Thank you, genuinely.", "",
    ...(streakLine ? [streakLine, ""] : []),
    "One ask: if you've got a club, putter or bag you're not using, list it on TeeBox. Snap a photo and set a price; Caddie writes the rest. It takes about two minutes.", "",
    `List something: ${CTA}`, "", "Jake", "Founder, TeeBox", "", "---",
    `Unsubscribe: ${unsubUrl}`, ADDRESS].join("\n");
  return { html, text };
}

const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] || true) : null; };

if (flag("--render")) {
  const out = flag("--render"); fs.mkdirSync(out, { recursive: true });
  const unsubUrl = email.makeUnsubscribeUrl({ uid: "SAMPLE_UID", category: CATEGORY });
  for (const [name, v] of [["named-streak", { first: "Chris", streak: 12 }], ["named", { first: "Chris", streak: 0 }], ["no-name", { first: "", streak: 0 }]]) {
    fs.writeFileSync(`${out}/thanks-nov-${name}.html`, render({ ...v, unsubUrl }).html);
  }
  console.log("rendered to", out);
} else if (flag("--test-to")) {
  const to = flag("--test-to"), uid = flag("--uid");
  const { html, text } = render({ first: "Jake", streak: 12, unsubUrl: email.makeUnsubscribeUrl({ uid, category: CATEGORY }) });
  // Test send: no uid passed to sendEmail so the consent preflight can't skip it.
  const r = await email.sendEmail({ to, subject: "[TEST] " + SUBJECT, html, text, category: CATEGORY,
    from: FROM, replyTo: REPLY_TO, template: "thanks_nov_test", tags: [{ name: "campaign", value: "thanks_nov" }] });
  console.log("test send:", JSON.stringify(r));
} else if (flag("--send")) {
  const rows = JSON.parse(fs.readFileSync(flag("--audience"), "utf8"));
  const offset = Number(flag("--offset") || 0), limit = Number(flag("--limit") || 20);
  const batch = rows.slice(offset, offset + limit);
  const res = { sent: 0, skipped: {}, failed: 0 };
  for (const row of batch) {
    const u = await admin.auth().getUser(row.uid);
    if (!u.email) { res.skipped["no-email"] = (res.skipped["no-email"] || 0) + 1; continue; }
    const { html, text } = render({ first: firstName(row.first), streak: row.streak, unsubUrl: email.makeUnsubscribeUrl({ uid: row.uid, category: CATEGORY }) });
    const r = await email.sendEmail({ to: u.email, uid: row.uid, subject: SUBJECT, html, text, category: CATEGORY,
      from: FROM, replyTo: REPLY_TO, template: "thanks_nov", tags: [{ name: "campaign", value: "thanks_nov" }],
      idempotencyKey: `thanks_nov_${row.uid}` });
    if (r && r.skipped) res.skipped[r.reason] = (res.skipped[r.reason] || 0) + 1;
    else if (r && r.error) res.failed++;
    else res.sent++;
  }
  console.log(`batch offset=${offset} limit=${limit}:`, JSON.stringify(res));
} else {
  console.log("usage: --render <dir> | --test-to <email> --uid <uid> | --send --audience <json> --offset N --limit N");
}
