# Migration: GitHub Pages → Firebase Hosting

End-to-end playbook for cutting `teeboxmarket.com` over from GitHub
Pages to Firebase Hosting. The repo is already prepped — `firebase.json`
points at `dist/`, security headers are configured, and `npm run
deploy:hosting` is wired. This doc is the **operator checklist** for
the actual cutover.

**Why migrate?**

- Activates the security headers in `firebase.json` (HSTS preload,
  X-Frame-Options, Permissions-Policy, COOP, etc.) — currently dead
  code because GitHub Pages doesn't support custom response headers.
  This closes finding **M2** in `SECURITY_AUDIT.md`.
- Brings web hosting onto the same Firebase project as Auth/Firestore/
  Functions/Storage — single dashboard, single billing line, single
  CLI for deploys.
- Faster rollback (`firebase hosting:rollback`) and atomic deploys.
- Per-PR preview channels (`firebase hosting:channel:deploy <name>`).

**What stays the same:**

- The custom domain `teeboxmarket.com`.
- Cloud Functions, Firestore rules, Storage rules, Auth flows.
- The build script `npm run build:web` (writes to `dist/`).
- The `CNAME` file in the repo (keep it until step 8 — harmless until
  you remove the GitHub Pages site).

---

## Pre-flight (do these the day before, not in the moment)

### 1. Lower the DNS TTL on the existing GitHub Pages records

The current TTL on `teeboxmarket.com` A records is the default (~6h).
You need this short so the cutover propagates fast.

DNS for `teeboxmarket.com` is hosted at **Google Cloud DNS** (NS
records currently point at `ns-cloud-eX.googledomains.com.`), so:

1. Open Google Cloud Console → **Network services** → **Cloud DNS** →
   `teeboxmarket.com` zone.
2. Edit each `A` record currently pointing at GitHub Pages
   (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
   `185.199.111.153`):
   - **TTL: `300`** (5 minutes).
3. Same for the `www` record (CNAME to `<user>.github.io` or A records).
4. Wait **at least 1 hour** before doing the cutover so old caches
   expire to the new TTL.

Verify:
```bash
dig teeboxmarket.com | grep -A1 "ANSWER SECTION"
# TTL should now read ≤ 300
```

### 2. Confirm Firebase CLI access

```bash
npx --yes firebase-tools login            # opens browser; auth as project owner
npx --yes firebase-tools projects:list    # confirm 'teebox-market' shows up
npx --yes firebase-tools use teebox-market
```

### 3. Verify the `dist/` build is current

```bash
npm run build:web
ls -la dist/index.html dist/assets dist/brand
# should all exist
```

---

## Step 1 — First deploy without a DNS change

This deploys the site to Firebase Hosting at the default URLs
**without touching your custom domain**. GitHub Pages keeps serving
`teeboxmarket.com` while you smoke-test the Firebase build.

```bash
npm run deploy:hosting
```

This runs:
1. `npm run build:web` — fresh `dist/`
2. `npx firebase-tools deploy --only hosting --project teebox-market`

Output ends with two URLs:
- `https://teebox-market.web.app`
- `https://teebox-market.firebaseapp.com`

Both serve the same content as `teeboxmarket.com` will after cutover.

---

## Step 2 — Smoke-test the `.web.app` URL

Open `https://teebox-market.web.app` in a fresh incognito window and
walk every flow:

- [ ] Home page loads, listings render.
- [ ] Listing detail page (`/listing/<id>`) loads — confirms SPA
      rewrites work.
- [ ] Seller page (`/seller/<id>`) loads.
- [ ] Sign-in: email/password.
- [ ] Sign-in: Google (popup). **If this fails**, you need to add
      `https://teebox-market.web.app` to:
      - Firebase console → Authentication → Settings → Authorized
        domains.
      - Google Cloud console → APIs & Services → Credentials → OAuth
        2.0 Web client → Authorized JavaScript origins.
      (You'll repeat this for `teeboxmarket.com` after cutover, but
      it should already be there.)
- [ ] Sign-in: Apple (web).
- [ ] Create a listing (test account).
- [ ] Send a message.
- [ ] Stripe test purchase (`4242 4242 4242 4242`).
- [ ] Service worker registers and offline page works (DevTools →
      Application → Service Workers).
- [ ] Response headers — open DevTools → Network → click `index.html`:
      ```
      strict-transport-security: max-age=63072000; includeSubDomains; preload
      x-frame-options: SAMEORIGIN
      x-content-type-options: nosniff
      referrer-policy: strict-origin-when-cross-origin
      permissions-policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
      cross-origin-opener-policy: same-origin-allow-popups
      cross-origin-resource-policy: same-site
      cache-control: public, max-age=0, s-maxage=600, must-revalidate   # for HTML
      ```
- [ ] Cache-control on a fingerprinted asset (e.g. `/assets/...`)
      should read `public, max-age=31536000, ..., immutable`.

**If anything fails, stop here.** GitHub Pages is still live; nothing
about your prod site has changed. Fix the Firebase build and redeploy
with `npm run deploy:hosting`.

---

## Step 3 — Connect the custom domain in the Firebase console

1. Open [Firebase console](https://console.firebase.google.com/) →
   project **teebox-market** → **Hosting**.
2. Click **Add custom domain**.
3. Enter **`teeboxmarket.com`** (the apex — without `www`).
4. Firebase asks you to verify ownership via a TXT record. Copy the
   record it shows (`google-site-verification=...` or similar).
5. In Google Cloud DNS → `teeboxmarket.com` zone → **Add record set**
   → **TXT** → name `@`, value the string Firebase gave you, TTL `300`.
6. Back in the Firebase console, click **Verify**. (May take 1–10
   min for the TXT record to propagate.)
7. Once verified, Firebase shows you **A records** to add — typically:
   ```
   199.36.158.100
   ```
   (Firebase may list two IPs; add both as separate A records.)
8. **DON'T REPLACE THE GITHUB PAGES A RECORDS YET.** This is step 4.
9. Repeat the "Add custom domain" flow for **`www.teeboxmarket.com`**.
   When prompted, choose **"Redirect"** → target `teeboxmarket.com`.
   This makes Firebase 301 `www.teeboxmarket.com` → apex automatically
   (cleaner than handling it in `firebase.json`, which doesn't support
   cross-host redirects).

---

## Step 4 — Cut DNS over from GitHub Pages to Firebase

This is the actual cutover. After this step, traffic starts hitting
Firebase.

In Google Cloud DNS → `teeboxmarket.com` zone:

1. **Delete** the four GitHub Pages A records:
   - `185.199.108.153`
   - `185.199.109.153`
   - `185.199.110.153`
   - `185.199.111.153`
2. **Add** the Firebase A records from step 3.7 (typically
   `199.36.158.100` — confirm in your console; Firebase has updated
   their IPs in the past).
3. For `www`: delete the existing `www` record and add either:
   - The Firebase A records (if you connected `www` as a redirect
     target — Firebase serves the redirect from those same IPs), or
   - A CNAME to `teeboxmarket.com` (if your DNS provider supports
     CNAME-flattening on a subdomain).
4. Keep TTL at `300` for the next 24 hours so you can roll back fast
   if something goes sideways.

---

## Step 5 — Wait for DNS propagation

Typically 5 minutes – 1 hour. Watch:

```bash
dig +short teeboxmarket.com
# old:  185.199.108.153 / 109.153 / 110.153 / 111.153  (GitHub Pages)
# new:  199.36.158.100  (Firebase)
```

Also check from a public resolver to bypass local cache:
```bash
dig +short @8.8.8.8 teeboxmarket.com
dig +short @1.1.1.1 teeboxmarket.com
```

Don't proceed to step 6 until both resolvers return Firebase IPs.

---

## Step 6 — Wait for Firebase to issue the SSL cert

Firebase auto-provisions a Let's Encrypt cert as soon as it sees DNS
pointing at its IPs. In the Firebase console → Hosting → your domain:

- Status will go from **Needs setup** → **Pending** → **Connected**.
- Takes ~5 min to ~24 h. Most domains finish in under 30 min.
- A green ✓ "Connected" with "SSL certificate provisioned" means
  HTTPS is live.

If it sticks at "Pending" longer than 1 hour, double-check the A
records in Cloud DNS — Firebase needs them to be its own IPs (and
nothing else).

---

## Step 7 — Verify production is now on Firebase

```bash
# IP check
dig +short teeboxmarket.com
# → 199.36.158.100 (or whichever Firebase IP you set)

# Header check (THIS IS THE BIG ONE — proves headers are live)
curl -sI https://teeboxmarket.com/ | grep -iE 'strict-transport|x-frame|x-content|referrer|permissions|cross-origin|cache-control|server'
```

You should see all of:
```
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-frame-options: SAMEORIGIN
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
permissions-policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
cross-origin-opener-policy: same-origin-allow-popups
cross-origin-resource-policy: same-site
cache-control: public, max-age=0, s-maxage=600, must-revalidate
```

The `server:` header should be missing or read something like
`Firebase` — definitely **not** `GitHub.com`.

Also re-run the smoke test from step 2 against `https://teeboxmarket.com`:
- [ ] Sign-in flows still work (Google, Apple, email/password).
- [ ] Listing/seller deep links resolve.
- [ ] Service worker still updates correctly (clear cache + reload).
- [ ] `/.well-known/apple-app-site-association` returns valid JSON
      with `Content-Type: application/json` (universal links rely on
      this).

Verify www → apex redirect:
```bash
curl -sI https://www.teeboxmarket.com/ | head -3
# should be:  HTTP/2 301
# location: https://teeboxmarket.com/
```

---

## Step 8 — (Optional) Decommission GitHub Pages

Only after **24 hours of stable traffic** on Firebase:

1. **Disable GitHub Pages** for the repo:
   - GitHub → repo → Settings → Pages → Source → **None** → Save.
   - This stops Pages from serving the site even if the DNS flips
     back accidentally.
2. **Delete `CNAME`** from the repo root:
   ```bash
   git rm CNAME
   git commit -m "chore: remove CNAME, site is on Firebase Hosting"
   git push
   ```
3. **Bump TTL back up** in Cloud DNS to `3600` (1h) or `21600` (6h)
   for the A records — you no longer need fast-cutover headroom.
4. **Update the deploy mechanism note in your project memory:**
   - `~/.claude/projects/-Users-jakenair-Desktop-teebox/memory/deploy-pipeline.md`
     currently says "teeboxmarket.com is GitHub Pages, not Firebase
     Hosting. Must `git push` for changes to land." Update to:
     "teeboxmarket.com is Firebase Hosting (project `teebox-market`).
     Deploy with `npm run deploy:hosting`. `git push` no longer
     deploys the live site."
5. Update `scripts/launch-deploy.sh` step 6 — change the `git push`
   step's label from "GitHub Pages → teeboxmarket.com" to
   "Firebase Hosting deploy: npm run deploy:hosting".

---

## Rollback

If anything is broken at any point **after step 4** (DNS already
flipped):

1. Open Cloud DNS → `teeboxmarket.com` zone.
2. Delete the Firebase A records.
3. Re-add the four GitHub Pages A records:
   - `185.199.108.153`
   - `185.199.109.153`
   - `185.199.110.153`
   - `185.199.111.153`
4. With TTL still at `300`, the rollback hits production within ~5
   min. Verify with `dig +short teeboxmarket.com`.

The `CNAME` file in the repo is still there, so GitHub Pages picks
up where it left off the moment DNS resolves back to its IPs.

---

## Time estimate

- **Hands-on operator time:** ~30 min (steps 1, 2, 3, 4, 7).
- **Wait time:** ~10 min (DNS propagation, step 5) + ~5–60 min (cert
  provisioning, step 6) + 24 h (soak before decommissioning Pages,
  step 8).
- **Best case end-to-end (excluding the soak):** ~1 hour.
- **Realistic:** schedule a 2-hour block for steps 1–7, then leave
  it alone for 24 hours before step 8.

Do this on a low-traffic weekday morning (your time) so you have a
full work day to react to any issue.
