# GDPR Marketing-Consent Schema

This document specifies the data model and operational rules for
TeeBox's marketing-consent capture, audit trail, and revocation flow.
The implementation must remain consistent with this spec — any change
that affects the user-visible consent language requires bumping
`CURRENT_CONSENT_VERSION` (in `functions/gdprConsent.js`), which forces
re-consent across the user base.

## Legal basis

GDPR Art. 6(1)(a) + Art. 7 require **freely-given, specific, informed,
unambiguous, affirmative** consent for direct marketing email.
Pre-checked boxes are explicitly non-compliant
(EDPB Guidelines 05/2020). CCPA/CPRA permits opt-out for "share/sell"
but requires opt-in for sensitive PI; we apply the stricter GDPR
standard globally to simplify the data model.

Transactional email (order confirmations, security alerts, payouts)
does **not** require marketing consent and is exempt from this gate
(see `TRANSACTIONAL_CATEGORIES` in `functions/lib/email.js`).

## Fields

All consent fields are written to `users/{uid}`. Direct client writes
are denied by Firestore rules — the client must round-trip through the
`updateMarketingConsent` callable so the server can stamp
`serverTimestamp()` and append to history.

```
users/{uid}.marketingConsent: {
  granted:   boolean,
  grantedAt: Timestamp | null,    // when they said yes (null if revoked)
  revokedAt: Timestamp | null,    // when they said no  (null if granted)
  source:    'signup'
           | 'banner_reopt'
           | 'prefs_toggle'
           | 'migration_default_off',
  version:   1,                   // CURRENT_CONSENT_VERSION; bump → re-consent
  history:   [
    {
      granted:   boolean,
      at:        Timestamp,
      source:    string,
      ip:        string | null,
      userAgent: string | null
    },
    ...                           // bounded to 50 entries (MAX_HISTORY)
  ]
}

users/{uid}.marketingBannerDismissedAt: Timestamp
```

### Field semantics

- **granted=true with grantedAt=null** is invalid (write should never
  produce this). The callable always stamps both atomically.
- **history** is append-only via `FieldValue.arrayUnion(...)`. A
  best-effort post-write trim keeps it under `MAX_HISTORY` (50).
- **source** distinguishes consent provenance for compliance
  reporting. `migration_default_off` is reserved for the one-time
  cohort migration (see `scripts/migrate-marketing-consent.mjs`).
- **version** bumps invalidate prior consent. The send gate compares
  `marketingConsent.version` against `CURRENT_CONSENT_VERSION` and
  treats stale versions the same as missing consent. (Not yet wired
  — bump triggers a manual re-prompt via the banner.)

## Email-send gate

`functions/lib/email.js` → `preflightAllowed({uid, category})`:

For any `category` in `MARKETING_CATEGORIES`:
1. Read `users/{uid}.marketingConsent`.
2. If missing or `granted !== true` → return
   `{allowed: false, reason: 'no-marketing-consent'}`.
3. Otherwise check `emailPrefs[category]` as before; `false` blocks
   the send (per-category unsubscribe still works).

Transactional categories bypass the consent check entirely. Hard
suppressions (`emailSuppressions/{uid}` or
`users/{uid}.emailSuppressed === true`) beat both.

`MARKETING_CATEGORIES` is the set:
```
savedSearchMatches, priceDrops, abandonedDraft, abandonedCart,
reviewRequests, winBack, weeklyDigest, productUpdates
```

## Callables

### `updateMarketingConsent({ granted, source })`

- Auth required.
- `source` allowlist: `signup`, `banner_reopt`, `prefs_toggle`,
  `migration_default_off`.
- Writes `marketingConsent.*` server-side with `serverTimestamp()`.
- Appends an entry to `history` (granted, at, source, ip, userAgent).
- Cascades: sets all 8 marketing `emailPrefs.{cat}` to match `granted`.
- IP / UA captured for audit; subject to retention policy.

### `dismissMarketingBanner()`

- Auth required.
- Writes `users/{uid}.marketingBannerDismissedAt = serverTimestamp()`.
- Does NOT grant consent — the user remains in "no consent" state and
  sends remain gated.

## Firestore rules

`users/{uid}.marketingConsent` and
`users/{uid}.marketingBannerDismissedAt` are **server-write only**.
Client writes are denied by the existing strict allow-list:

```
allow update: if ...
  && request.resource.data.diff(resource.data).affectedKeys().hasOnly(
       ['phone','termsAgreed','termsAgreedAt','displayName','watchlist','blocked']);
```

`marketingConsent` and `marketingBannerDismissedAt` are not in that
list, so client attempts to write them fail. The Admin SDK (used by
the callables) bypasses rules.

## Retention

- `marketingConsent.history` entries are retained for the lifetime of
  the account; on `users/{uid}` deletion they are deleted with the
  document.
- IP addresses in history are stored only when the change was made via
  a callable (i.e. client action), not for migration_default_off
  entries.
- On account deletion request (GDPR Art. 17), the entire user document
  is deleted, including `marketingConsent`. Mirror entries in
  `emailSends/` should be cleaned up by the existing data-retention
  job (see `EMAIL_OPS_RUNBOOK.md`).

## Migration

See `scripts/migrate-marketing-consent.mjs`. The default migration
behavior is **opt-out** (`granted: false, source:
'migration_default_off'`) — i.e. all users without an explicit
consent record stop receiving marketing email at the next send. The
one-time re-opt-in banner then asks them to opt back in.

Migration is gated behind an explicit `--apply` flag; without it the
script runs as a dry-run and writes a report to
`/tmp/marketing-consent-migration-report.json`.
