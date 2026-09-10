import { useQuery } from '@tanstack/react-query';

export interface DevParty {
  party: string;
  name: string;
  dialogCount: number;
  isPerson: boolean;
}

interface DevSession {
  /** False when the BFF runs without ENABLE_DEV_USER_SWITCH, in which case /api/dev/* is not routed. */
  enabled: boolean;
  pid: string | null;
}

/** "urn:altinn:person:identifier-no:01039012345" -> "01039012345" */
export const identifierOf = (party: string): string => party.slice(party.lastIndexOf(':') + 1);

/**
 * Whether the switcher may be shown, and who the session currently belongs to.
 *
 * The gate is a runtime probe rather than import.meta.env.DEV so that it follows the BFF's
 * ENABLE_DEV_USER_SWITCH rather than how the bundle happened to be built: a 404 means the dev
 * routes were never registered, which is the case in every deployed environment. It also keeps
 * the picker hidden when a local dev build is pointed at a BFF that does not allow switching.
 */
export const useDevSession = () =>
  useQuery<DevSession>({
    queryKey: ['devSession'],
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async () => {
      const response = await fetch('/api/dev/current-user', { credentials: 'include' });
      if (!response.ok) {
        return { enabled: false, pid: null };
      }
      const body = (await response.json()) as { pid: string | null };
      return { enabled: true, pid: body.pid };
    },
  });

/** Only queried once the panel is open: listing parties walks every dialog in the database. */
export const useDevParties = (enabled: boolean) =>
  useQuery<DevParty[]>({
    queryKey: ['devParties'],
    enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const response = await fetch('/api/dev/parties', { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`/api/dev/parties returned ${response.status}`);
      }
      const body = (await response.json()) as { parties: DevParty[] };
      return body.parties;
    },
  });

export const switchUser = async (pid: string): Promise<void> => {
  const response = await fetch('/api/dev/switch-user', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid }),
  });

  if (!response.ok) {
    throw new Error(`switch-user failed with ${response.status}`);
  }
};
