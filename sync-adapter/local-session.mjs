#!/usr/bin/env node
/**
 * Oppretter en BFF-sesjon lokalt uten ID-porten.
 *
 * Bruker /api/init-session (packages/bff/src/auth/oidc.ts:201), som base64-dekoder
 * JWT-payloaden og plukker ut `pid` og `exp` — uten å verifisere signaturen.
 * verifyToken.ts sjekker deretter kun utløpstid, aldri signatur, så et
 * selvlaget token holder for BFF-laget.
 *
 * Merk: access_token videresendes som Bearer til Dialogporten (graphql/api.ts:30).
 * Kjører Dialogporten med UseLocalDevelopmentUser=true, ignoreres tokenet der og
 * identiteten er hardkodet til pid 03886595947. Skal du bruke en annen testbruker,
 * må Dialogporten-siden endres — se Route A/B i oppsettsnotatet.
 *
 *   node scripts/local-session.mjs [pid] [--host https://app.localhost] [--days 30]
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

// Standard = Dialogportens hardkodede LocalDevelopmentUser.
const pid = args.find((a) => !a.startsWith('--') && !/^https?:/.test(a)) ?? '03886595947';
const host = flag('host', 'https://app.localhost');
const days = Number(flag('days', '30'));

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + days * 86400;

// Signaturen er vilkårlig — BFF verifiserer den ikke.
const token = [
  b64url({ alg: 'none', typ: 'JWT' }),
  b64url({ pid, exp, iat: Math.floor(Date.now() / 1000), acr: 'idporten-loa-high' }),
  'local',
].join('.');

// mkcert-sertifikatet er ikke i Nodes trust store.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const res = await fetch(`${host}/api/init-session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token }),
});

if (!res.ok) {
  console.error(`init-session feilet: ${res.status} ${res.statusText}`);
  console.error(await res.text());
  console.error('\nSjekk at BFF kjører (docker logs bff) og at ENABLE_INIT_SESSION_ENDPOINT=true.');
  process.exit(1);
}

const { cookie, expires } = await res.json();
const [, value] = cookie.split('=');

console.log(`pid:     ${pid}`);
console.log(`utløper: ${expires}`);
console.log(`\nCookie:\n  ${cookie}`);
console.log(`\nSett den i nettleseren på ${host} (DevTools → Console):`);
console.log(`  document.cookie = '${cookie}; path=/';`);
console.log(`\nEller verifiser direkte:`);
console.log(`  curl -sk -b 'arbeidsflate=${value}' ${host}/api/isAuthenticated`);
