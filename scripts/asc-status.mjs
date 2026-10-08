#!/usr/bin/env node
/**
 * scripts/asc-status.mjs — what App Store Connect says right now.
 *
 *   node scripts/asc-status.mjs
 *
 * Prints review submissions, App Store version states, and the newest builds.
 * Auth: the ASC API key at ~/Downloads/AuthKey_QJKN93F6FA.p8 (key id QJKN93F6FA,
 * issuer in ASC_ISSUER below). Read-only; prints nothing secret.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const APP = '6763954448';
const KID = process.env.ASC_KEY_ID || 'QJKN93F6FA';
const ISS = process.env.ASC_ISSUER || 'ce19d09b-06d6-42e8-aea8-f96c3f2325d6';
const KEY_PATH = process.env.ASC_KEY_PATH || `${os.homedir()}/Downloads/AuthKey_${KID}.p8`;
const key = fs.readFileSync(KEY_PATH, 'utf8');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = b64({alg: 'ES256', kid: KID, typ: 'JWT'}) + '.' + b64({iss: ISS, iat: now, exp: now + 1100, aud: 'appstoreconnect-v1'});
const jwt = unsigned + '.' + crypto.sign('sha256', Buffer.from(unsigned), {key, dsaEncoding: 'ieee-p1363'}).toString('base64url');
const api = async (p) => {
  const r = await fetch('https://api.appstoreconnect.apple.com/v1' + p, {headers: {Authorization: 'Bearer ' + jwt}});
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j.errors || j).slice(0, 200)}`);
  return j;
};

const rs = await api(`/reviewSubmissions?filter[app]=${APP}&limit=5&fields[reviewSubmissions]=state,platform,submittedDate`);
console.log('\n  Review submissions');
for (const r of rs.data) console.log(`    ${r.attributes.state.padEnd(22)} submitted ${(r.attributes.submittedDate || '—').slice(0, 16)}  ${r.id.slice(0, 8)}`);

const vs = await api(`/apps/${APP}/appStoreVersions?limit=4&fields[appStoreVersions]=versionString,appVersionState,createdDate&include=build&fields[builds]=version`);
console.log('\n  App Store versions');
for (const v of vs.data) {
  const b = (vs.included || []).find((i) => i.id === v.relationships?.build?.data?.id);
  console.log(`    ${v.attributes.versionString.padEnd(7)} ${v.attributes.appVersionState.padEnd(26)} build ${b ? b.attributes.version : '—'}`);
}

const builds = await api(`/builds?filter[app]=${APP}&sort=-uploadedDate&limit=4&fields[builds]=version,processingState,uploadedDate&include=preReleaseVersion&fields[preReleaseVersions]=version`);
console.log('\n  Newest builds');
for (const b of builds.data) {
  const pv = (builds.included || []).find((i) => i.id === b.relationships?.preReleaseVersion?.data?.id);
  console.log(`    ${(pv ? pv.attributes.version : '?').padEnd(7)} ${b.attributes.version.padEnd(5)} ${b.attributes.processingState.padEnd(10)} ${(b.attributes.uploadedDate || '').slice(0, 16)}`);
}
console.log('');
