import { logger } from '@altinn/dialogporten-node-logger';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import config from '../config.ts';

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const NORWEGIAN_PERSON_IDENTIFIER = /^\d{11}$/u;
const PERSON_PREFIX = 'urn:altinn:person:identifier-no:';

/** Service owner search caps out at 1000, and a smaller page only means more round trips. */
const DIALOG_PAGE_SIZE = 1000;
/** A stuck continuation token would otherwise loop forever; no local database is this big. */
const MAX_DIALOG_PAGES = 100;
/** Long enough that opening the picker twice in a row is one query, short enough to see new dialogs. */
const PARTIES_TTL_MS = 15_000;

interface DevParty {
  party: string;
  name: string;
  dialogCount: number;
  isPerson: boolean;
}

/** "urn:altinn:person:identifier-no:01039012345" -> "01039012345" */
const identifierOf = (party: string): string => party.slice(party.lastIndexOf(':') + 1);

/** localtest-sync writes "…|owner=<name>" into externalReference; this reads it back out. */
const OWNER_MARKER = '|owner=';

const ownerNameFrom = (externalReference?: string): string | null => {
  if (!externalReference) {
    return null;
  }
  const index = externalReference.indexOf(OWNER_MARKER);
  if (index < 0) {
    return null;
  }
  return externalReference.slice(index + OWNER_MARKER.length).trim() || null;
};

interface PartyTally {
  dialogCount: number;
  /** From the dialog's externalReference, when localtest-sync put it there. */
  name: string | null;
}

/**
 * Tallies dialogs per party across the whole local database, picking up any owner name the
 * importing tool left on the dialog.
 *
 * The service owner search is used rather than the end user API because the latter only ever
 * answers for the parties the caller is authorized for — which is precisely the thing the picker
 * exists to change.
 */
const countDialogsByParty = async (): Promise<Map<string, PartyTally>> => {
  const counts = new Map<string, PartyTally>();
  let continuationToken: string | undefined;

  for (let page = 0; page < MAX_DIALOG_PAGES; page++) {
    const url = new URL(`${config.dialogporten.serviceOwnerApiUrl}/api/v1/serviceowner/dialogs`);
    url.searchParams.set('limit', String(DIALOG_PAGE_SIZE));
    if (continuationToken) {
      url.searchParams.set('continuationToken', continuationToken);
    }

    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`serviceowner/dialogs returned ${response.status}`);
    }

    const body = (await response.json()) as {
      items?: { party?: string; externalReference?: string }[];
      hasNextPage?: boolean;
      continuationToken?: string;
    };

    for (const item of body.items ?? []) {
      if (!item.party) {
        continue;
      }
      const tally = counts.get(item.party) ?? { dialogCount: 0, name: null };
      tally.dialogCount += 1;
      tally.name ??= ownerNameFrom(item.externalReference);
      counts.set(item.party, tally);
    }

    // Paging matters even locally: a party whose dialogs all sort onto a later page would
    // otherwise be missing from the picker entirely.
    if (!body.hasNextPage || !body.continuationToken || body.continuationToken === continuationToken) {
      return counts;
    }
    continuationToken = body.continuationToken;
  }

  logger.warn(`Stopped counting dialogs after ${MAX_DIALOG_PAGES} pages; the party list may be incomplete`);
  return counts;
};

/**
 * Fallback name lookup, for parties whose dialogs carry no owner marker.
 *
 * LocalTest only answers for parties it registered itself and returns 404 for the ones that live
 * as static files under testdata/Register/Party — those arrive via the owner marker instead.
 * Dialogporten cannot help either: its local party name registry answers with a fixed placeholder.
 *
 * Names never change while LocalTest is running, so a resolved one is kept for the life of the
 * process. A miss is cached too — an identifier LocalTest does not know will not start knowing it.
 */
const nameCache = new Map<string, string | null>();

const resolveName = async (party: string): Promise<string | null> => {
  const cached = nameCache.get(party);
  if (cached !== undefined) {
    return cached;
  }

  const identifier = identifierOf(party);
  const body = party.startsWith(PERSON_PREFIX) ? { Ssn: identifier } : { OrgNo: identifier };

  let name: string | null = null;
  try {
    const response = await fetch(`${config.localtestUrl}/register/api/v1/parties/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      const lookup = (await response.json()) as { name?: string };
      name = lookup.name?.trim() || null;
    }
  } catch (error) {
    // A missing LocalTest is normal — the picker still works, just with bare identifiers.
    logger.debug({ error, party }, 'LocalTest name lookup failed');
  }

  nameCache.set(party, name);
  return name;
};

let partiesCache: { at: number; parties: DevParty[] } | null = null;

const listParties = async (): Promise<DevParty[]> => {
  if (partiesCache && Date.now() - partiesCache.at < PARTIES_TTL_MS) {
    return partiesCache.parties;
  }

  const counts = await countDialogsByParty();
  const parties = await Promise.all(
    [...counts].map(async ([party, tally]) => ({
      party,
      dialogCount: tally.dialogCount,
      isPerson: party.startsWith(PERSON_PREFIX),
      name: tally.name ?? (await resolveName(party)) ?? identifierOf(party),
    })),
  );

  parties.sort((a, b) => b.dialogCount - a.dialogCount || a.name.localeCompare(b.name, 'nb'));
  partiesCache = { at: Date.now(), parties };
  return parties;
};

/**
 * Lets the inbox switch which person the local session belongs to, listing every party that holds
 * a dialog in the local Dialogporten.
 *
 * This has to be a server endpoint: the session cookie is httpOnly, so a front end cannot install
 * one with document.cookie. Dialogporten reads the pid straight off the bearer token minted here,
 * so the whole stack follows along without a restart.
 *
 * Gated on ENABLE_DEV_USER_SWITCH, which is set only in this repo's compose.yml. When it is off the
 * routes are never registered, which is also how the front end knows not to render the picker.
 */
const plugin: FastifyPluginAsync = async (fastify) => {
  if (!config.enableDevUserSwitch) {
    return;
  }

  logger.warn('ENABLE_DEV_USER_SWITCH is on: /api/dev/switch-user can mint a session for any pid');

  // The frontend cannot read the current pid from GraphQL, where person URNs come back encrypted.
  // A 404 from this route is what tells the picker to stay hidden.
  fastify.get('/api/dev/current-user', async (request: FastifyRequest, reply: FastifyReply) => {
    const pid = request.session?.get('pid') as string | undefined;
    return reply.status(200).send({ pid: pid ?? null });
  });

  fastify.get('/api/dev/parties', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.status(200).send({ parties: await listParties() });
    } catch (error) {
      logger.error(error, 'Failed to list parties holding dialogs');
      return reply.status(502).send({ error: 'Could not reach Dialogporten' });
    }
  });

  fastify.post('/api/dev/switch-user', async (request: FastifyRequest, reply: FastifyReply) => {
    const { pid } = (request.body ?? {}) as { pid?: string };

    if (!pid || !NORWEGIAN_PERSON_IDENTIFIER.test(pid)) {
      return reply.status(400).send({ error: 'pid must be 11 digits' });
    }

    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

      // An unsigned token: a local Dialogporten runs with DisableAuth and only reads the pid.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          pid,
          exp: Math.floor(expiresAt.getTime() / 1000),
          iat: Math.floor(now.getTime() / 1000),
          acr: 'idporten-loa-high',
        }),
      ).toString('base64url');
      const accessToken = `${header}.${payload}.unsigned`;

      // The existing session is repointed at the new person rather than a new one being minted.
      // fastify-session runs with rolling: true, so it rewrites the session cookie after this
      // handler returns — a reply.setCookie here would simply be overwritten with the old id.
      request.session.set('token', {
        access_token: accessToken,
        access_token_expires_at: expiresAt.toISOString(),
        tokenUpdatedAt: now.toISOString(),
        // Never used: the token is valid for a day, so verifyToken never attempts a refresh.
        id_token: accessToken,
        refresh_token: '',
        refresh_token_expires_at: expiresAt.toISOString(),
        scope: 'openid',
      });
      request.session.set('pid', pid);

      logger.info(`Dev user switch to ${pid}`);
      return reply.status(200).send({ pid, expires: expiresAt.toISOString() });
    } catch (error) {
      logger.error(error, 'Failed to switch dev user');
      return reply.status(500).send({ error: 'Failed to switch user' });
    }
  });
};

export default fp(plugin, {
  fastify: '5.x',
  name: 'dev-user-switch',
});
