#!/usr/bin/env node
/**
 * LocalTest → Dialogporten sync-adapter.
 *
 * Leser appinstanser fra Altinn Studio sin lokale platform-lagring og speiler dem
 * som dialoger i lokal Dialogporten, slik at de dukker opp i arbeidsflate-innboksen
 * med en lenke tilbake til appen.
 *
 * Instansformatet (documentdb/instances/<partyId>_<guid>.json):
 *   { id, instanceOwner: { partyId, personNumber | organisationNumber },
 *     appId: "<org>/<app>", org, process: { currentTask, ended }, status: {...},
 *     created, lastChanged, visibleAfter }
 *
 *   node scripts/localtest-sync.mjs [--once] [--party <id>] [--dry-run] [--verbose]
 *
 * Uten --once kjører den i watch-modus og synker fortløpende.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const val = (f, d) => {
  const i = args.indexOf(`--${f}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};

const ONCE = has('once');
const DRY = has('dry-run');
const VERBOSE = has('verbose');
const PARTY_FILTER = val('party', process.env.LOCALTEST_PARTY ?? null);

const STORAGE =
  process.env.LOCALTEST_STORAGE ??
  path.join(os.homedir(), 'Library/Application Support/altinn-studio/data/AltinnPlatformLocal');
const INSTANCE_DIR = path.join(STORAGE, 'documentdb/instances');
// Partsregisteret ligger utenfor AltinnPlatformLocal og er ren testdata på disk.
// LocalTests /register/api/v1/parties/lookup kjenner ikke disse partene — den svarer 404
// for alt annet enn parter den selv har registrert — så navnene må leses fra filene.
const PARTY_DIR = path.join(STORAGE, '..', 'testdata/Register/Party');
const DP_API = (process.env.DIALOGPORTEN_API ?? 'http://localhost:7214').replace(/\/$/, '');
// LocalTest må treffes direkte på :8000 over http. Bak en TLS-proxy bygger den
// redirect-URL-er fra Host-headeren, mister porten, og sender deg til feil origin.
// Dialogporten godtar http her fordi IsValidHttpsUrl er lempet for lokale verter
// når ASPNETCORE_ENVIRONMENT=Development.
const LOCALTEST_BASE = (process.env.LOCALTEST_BASE ?? 'http://local.altinn.cloud:8000').replace(/\/$/, '');

/* ---------- part-identifikatorer ---------- */

/*
 * Kun form, ikke mod-11-kontrollsiffer. En lokal Dialogporten kjører med
 * LocalDevelopment.DisablePartyIdentifierControlDigits, og krever da bare riktig
 * lengde og at alt er siffer (PartyIdentifierValidation.SkipControlDigits).
 *
 * Syntetiske LocalTest-numre har stort sett ugyldige kontrollsiffer — Sophie Salt
 * (01039012345) og DDG Fitness (897069650) er to av dem — så en mod-11-sjekk her
 * ville kastet ut det meste av testdataene før de nådde Dialogporten.
 */
const isValidSsn = (v) => typeof v === 'string' && /^\d{11}$/.test(v);
const isValidOrgNo = (v) => typeof v === 'string' && /^\d{9}$/.test(v);

/**
 * partyId -> visningsnavn, lest fra testdatafilene.
 *
 * Navnet blir med videre i dialogens externalReference som "|owner=<navn>", slik at
 * konsumenter (brukervelgeren i innboksen) kan vise noe annet enn et elleve­sifret tall.
 * Dialogporten kan ikke slå det opp selv: det lokale partsnavnregisteret svarer med en
 * fast plassholder for alle identifikatorer.
 */
/**
 * Navn LocalTest har registrert selv, som Tenor-brukere, finnes ikke som fil under
 * testdata/Register/Party. De må hentes over API-et i stedet. Svaret bufres — også et
 * bomtreff, siden en identifikator LocalTest ikke kjenner ikke begynner å kjenne den.
 */
const lookedUpNames = new Map();

const lookupName = async (owner) => {
  const key = owner.personNumber ?? owner.organisationNumber;
  if (lookedUpNames.has(key)) return lookedUpNames.get(key);

  const body = owner.personNumber ? { Ssn: owner.personNumber } : { OrgNo: owner.organisationNumber };
  let name = null;
  try {
    const res = await fetch(`${LOCALTEST_BASE}/register/api/v1/parties/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) name = (await res.json())?.name?.trim() || null;
  } catch {
    // LocalTest nede eller ukjent part — da står identifikatoren som navn.
  }
  lookedUpNames.set(key, name);
  return name;
};

/** Legger på "|owner=<navn>" når navnet er kjent. Uten navn står referansen som før. */
const ownerMarker = (name, reference) => (name ? `${reference}|owner=${name}` : reference);

const partyNames = (() => {
  const names = new Map();
  let files = [];
  try {
    files = fs.readdirSync(PARTY_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return names; // Ingen testdata på denne maskinen — da blir det bare identifikatorer.
  }
  for (const file of files) {
    try {
      const party = JSON.parse(fs.readFileSync(path.join(PARTY_DIR, file), 'utf8'));
      if (party?.partyId && party?.name) names.set(String(party.partyId), party.name);
    } catch {
      // En ulesbar fil skal ikke stoppe synken.
    }
  }
  return names;
})();

const partyUrn = (owner) => {
  if (owner?.organisationNumber) {
    if (!isValidOrgNo(owner.organisationNumber)) {
      return { error: `orgnr ${owner.organisationNumber} er ikke 9 siffer — Dialogporten avviser det` };
    }
    return { urn: `urn:altinn:organization:identifier-no:${owner.organisationNumber}` };
  }
  if (owner?.personNumber) {
    if (!isValidSsn(owner.personNumber)) {
      return { error: `fnr ${owner.personNumber} er ikke 11 siffer — Dialogporten avviser det` };
    }
    return { urn: `urn:altinn:person:identifier-no:${owner.personNumber}` };
  }
  return { error: 'mangler personNumber/organisationNumber' };
};

/* ---------- deterministisk UUIDv7 ---------- */

/**
 * Dialogporten krever UUIDv7. Vi utleder den deterministisk fra instans-GUID-en,
 * slik at gjentatt sync treffer samme dialog i stedet for å lage duplikater.
 * Tidsstempelet tas fra instansens created, resten fra en hash av instans-id-en.
 */
const dialogIdFor = (instance) => {
  const ms = Date.parse(instance.created ?? Date.now());
  const h = crypto.createHash('sha256').update(instance.id).digest();
  const b = Buffer.alloc(16);
  b.writeUIntBE(Number.isFinite(ms) ? ms : Date.now(), 0, 6);
  h.copy(b, 6, 0, 10);
  b[6] = (b[6] & 0x0f) | 0x70; // versjon 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/* ---------- instans → dialog ---------- */

const statusFor = (instance) => {
  const { process: p = {}, status: s = {} } = instance;
  if (s.isArchived || p.ended) return 'Completed';
  const type = p.currentTask?.altinnTaskType;
  if (type === 'signing' || type === 'confirmation') return 'RequiresAttention';
  // En instans appen har opprettet, men brukeren ikke har åpnet ennå, er ikke et utkast.
  // Draft er i Dialogporten definert som "user-initiated dialogs not yet sent", og
  // Utkast-visningen i arbeidsflate filtrerer på nøyaktig den statusen — så en uåpnet
  // instans ville havnet under Utkast i stedet for i innboksen.
  //
  // readStatus er signalet: Altinn setter den til Read når brukeren åpner instansen.
  // Da faller dialogen tilbake til Draft ved neste sync, som er nettopp når brukeren
  // faktisk har begynt på den. statusFor inngår i fingerprint-en nedenfor, så
  // overgangen synkes selv om lastChanged står stille.
  if (s.readStatus === 'Unread') return 'NotApplicable';
  if (p.currentTask) return 'Draft';
  return 'InProgress';
};

/** Dialogens content-felter: ContentValue med mediaType. */
const text = (value, languageCode = 'nb') => ({ mediaType: 'text/plain', value: [{ languageCode, value }] });

/** guiActions[].title er derimot en ren liste av lokaliseringer, uten mediaType. */
const label = (value, languageCode = 'nb') => [{ languageCode, value }];

const toDialog = async (instance) => {
  const [org, app] = (instance.appId ?? '').split('/');
  const { urn: party, error } = partyUrn(instance.instanceOwner);
  if (error) return { skip: error };
  if (!org || !app) return { skip: `ugyldig appId "${instance.appId}"` };
  if (instance.status?.isHardDeleted) return { skip: 'hard-slettet' };

  const partyId = instance.instanceOwner.partyId;
  // Filene først: de dekker de statiske testpartene, som LocalTest-API-et ikke svarer for.
  const ownerName = partyNames.get(String(partyId)) ?? (await lookupName(instance.instanceOwner));
  const status = statusFor(instance);
  const task = instance.process?.currentTask;
  const summary = task?.name
    ? `${task.name}${task.altinnTaskType ? ` (${task.altinnTaskType})` : ''}`
    : status === 'Completed'
      ? 'Innsendt'
      : 'Påbegynt';

  return {
    id: dialogIdFor(instance),
    dto: {
      serviceResource: `urn:altinn:resource:app_${org}_${app}`,
      party,
      status,
      externalReference: ownerMarker(ownerName, `urn:altinn:instance:${partyId}/${instance.id}`),
      createdAt: instance.created,
      updatedAt: instance.lastChanged ?? instance.created,
      visibleFrom: instance.visibleAfter && Date.parse(instance.visibleAfter) > Date.now() ? instance.visibleAfter : undefined,
      content: {
        title: text(app),
        summary: text(summary),
        senderName: text(org.toUpperCase()),
      },
      guiActions: [
        {
          action: 'open',
          priority: 'Primary',
          httpMethod: 'GET',
          url: `${LOCALTEST_BASE}/${org}/${app}/instance/${partyId}/${instance.id}`,
          title: label(status === 'Completed' ? 'Se innsendt skjema' : 'Fortsett utfylling'),
        },
      ],
    },
  };
};

/* ---------- Dialogporten-kall ---------- */

const api = async (method, urlPath, body) => {
  const res = await fetch(`${DP_API}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: res.ok ? null : await res.text().catch(() => null) };
};

/**
 * Skriver dialog-ID-en tilbake på instansen som DataValue `dialog.id`.
 *
 * App-frontend leser nøyaktig denne nøkkelen (getDialogIdFromDataValues i
 * utils/urls/urlHelper.ts) når den bygger «tilbake til innboks»-lenken.
 *
 * LocalTest sitt storage-API (PUT .../datavalues) krever autorisasjon vi ikke har,
 * så vi skriver rett i den filbaserte lagringen. `lastChanged` røres ikke — både for
 * å unngå at vår egen fs.watch trigger en ny runde, og for ikke å forfalske
 * endringstidspunktet på instansen. Skrivingen er atomisk via rename.
 */
const writeDialogIdToInstance = (file, instance, dialogId) => {
  if (instance.dataValues?.['dialog.id'] === dialogId) {
    return false;
  }
  const updated = { ...instance, dataValues: { ...(instance.dataValues ?? {}), 'dialog.id': dialogId } };
  const target = path.join(INSTANCE_DIR, file);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(updated));
  fs.renameSync(tmp, target);
  return true;
};

const upsert = async (id, dto) => {
  const existing = await api('GET', `/api/v1/serviceowner/dialogs/${id}`);
  if (existing.status === 200) {
    // PUT er en full erstatning; id og serviceResource settes ikke om igjen.
    const { serviceResource: _sr, party: _p, createdAt: _c, ...updatable } = dto;
    const res = await api('PUT', `/api/v1/serviceowner/dialogs/${id}`, updatable);
    return res.status === 204 ? 'oppdatert' : `FEIL ved oppdatering (${res.status}): ${res.text}`;
  }
  const res = await api('POST', '/api/v1/serviceowner/dialogs', { id, ...dto });
  return res.status === 201 ? 'opprettet' : `FEIL ved opprettelse (${res.status}): ${res.text}`;
};

/* ---------- sync ---------- */

const readInstance = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(INSTANCE_DIR, file), 'utf8'));
  } catch {
    return null; // halvskrevet fil — watch-eventet kommer igjen
  }
};

const matchesFilter = (instance) => {
  if (!PARTY_FILTER) return true;
  const o = instance.instanceOwner ?? {};
  return [o.personNumber, o.organisationNumber, o.partyId].includes(PARTY_FILTER);
};

const lastSeen = new Map();

const syncFile = async (file) => {
  const instance = readInstance(file);
  if (!instance?.id || !matchesFilter(instance)) return;

  // Hopp over hvis innholdet er uendret siden forrige sync.
  const fingerprint = `${instance.lastChanged}|${statusFor(instance)}`;
  if (lastSeen.get(file) === fingerprint) return;

  const mapped = await toDialog(instance);
  if (mapped.skip) {
    if (VERBOSE) console.log(`  hoppet over ${file}: ${mapped.skip}`);
    lastSeen.set(file, fingerprint);
    return;
  }

  if (DRY) {
    console.log(`  [dry-run] ${instance.appId} ${mapped.dto.status} → ${mapped.id}`);
    console.log(`            ${mapped.dto.guiActions[0].url}`);
    console.log(`            dataValues['dialog.id'] = ${mapped.id}`);
    return;
  }

  const result = await upsert(mapped.id, mapped.dto);
  lastSeen.set(file, fingerprint);

  let tagged = '';
  if (!result.startsWith('FEIL')) {
    try {
      if (writeDialogIdToInstance(file, instance, mapped.id)) {
        tagged = ' + dialog.id';
      }
    } catch (err) {
      tagged = ` (kunne ikke skrive dialog.id: ${err.message})`;
    }
  }

  console.log(`  ${result.startsWith('FEIL') ? '✗' : '✓'} ${instance.appId} [${mapped.dto.status}] ${result}${tagged}`);
};

const syncAll = async () => {
  const files = fs.readdirSync(INSTANCE_DIR).filter((f) => f.endsWith('.json'));
  console.log(`Synker ${files.length} instanser fra ${INSTANCE_DIR}`);
  for (const f of files) await syncFile(f);
};

/* ---------- oppstart ---------- */

if (!fs.existsSync(INSTANCE_DIR)) {
  console.error(`Fant ikke instanskatalogen: ${INSTANCE_DIR}`);
  console.error('Sett LOCALTEST_STORAGE hvis Altinn Studio lagrer et annet sted.');
  process.exit(1);
}

console.log(`Dialogporten : ${DP_API}`);
console.log(`LocalTest    : ${LOCALTEST_BASE}`);
if (PARTY_FILTER) console.log(`Partsfilter  : ${PARTY_FILTER}`);
if (DRY) console.log('Modus        : dry-run (skriver ingenting)');

await syncAll();

if (!ONCE) {
  console.log('\nOvervåker for endringer — Ctrl+C for å avslutte.');
  const pending = new Map();
  fs.watch(INSTANCE_DIR, (_event, file) => {
    if (!file?.endsWith('.json')) return;
    // Debounce: LocalTest skriver filen i flere omganger.
    clearTimeout(pending.get(file));
    pending.set(
      file,
      setTimeout(() => {
        pending.delete(file);
        syncFile(file).catch((err) => console.error(`  ✗ ${file}: ${err.message}`));
      }, 300),
    );
  });
}
