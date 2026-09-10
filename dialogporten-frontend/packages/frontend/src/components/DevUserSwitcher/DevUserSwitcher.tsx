import { useEffect, useState } from 'react';
import styles from './devUserSwitcher.module.css';
import { type DevParty, identifierOf, switchUser, useDevParties, useDevSession } from './useDevUserSwitch.ts';

/**
 * Switches which person the local session belongs to, listing only the parties that actually hold
 * dialogs in the local Dialogporten.
 *
 * Local development only: the component renders nothing unless the BFF answers /api/dev/current-user,
 * which it does only with ENABLE_DEV_USER_SWITCH set. Switching goes through the BFF because the
 * session cookie is httpOnly and cannot be written from script.
 *
 * Organizations are listed for reference but not selectable: you cannot sign in as one. They are
 * reached through the ordinary party switcher in the header once you are signed in as a person who
 * represents them.
 */
export const DevUserSwitcher = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { data: session } = useDevSession();
  const { data: parties, isLoading, isError } = useDevParties(isOpen && Boolean(session?.enabled));

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  if (!session?.enabled) {
    return null;
  }

  const currentPid = session.pid;

  const onPick = async (party: DevParty) => {
    setPending(party.party);
    setFailed(false);
    try {
      await switchUser(identifierOf(party.party));
      // A full reload is the point: every cached query belongs to the previous user.
      location.reload();
    } catch {
      setFailed(true);
      setPending(null);
    }
  };

  const people = parties?.filter((party) => party.isPerson) ?? [];
  const organizations = parties?.filter((party) => !party.isPerson) ?? [];
  const current = parties?.find((party) => currentPid && identifierOf(party.party) === currentPid);

  return (
    <>
      {isOpen && (
        <button
          type="button"
          aria-label="Lukk brukervelgeren"
          className={styles.backdrop}
          onClick={() => setIsOpen(false)}
        />
      )}
      <div className={styles.root}>
        {isOpen && (
          <div className={styles.panel}>
            <div className={styles.heading}>Bytt lokal bruker</div>
            {isLoading && <div className={styles.message}>Laster …</div>}
            {isError && <div className={styles.error}>Fikk ikke hentet parter. Kjører Dialogporten lokalt?</div>}
            {failed && <div className={styles.error}>Byttet feilet. Se loggen: docker logs bff</div>}

            {!isLoading && !isError && people.length === 0 && organizations.length === 0 && (
              <div className={styles.message}>
                Ingen parter har dialoger ennå. Kjør sync-adapteren for å opprette noen.
              </div>
            )}

            {people.length > 0 && <div className={styles.group}>Personer</div>}
            {people.map((party) => {
              const identifier = identifierOf(party.party);
              const isActive = identifier === currentPid;
              return (
                <button
                  type="button"
                  key={party.party}
                  className={`${styles.item} ${isActive ? styles.active : ''}`}
                  disabled={pending !== null || isActive}
                  onClick={() => onPick(party)}
                >
                  <span className={styles.name}>
                    {party.name}
                    <span className={styles.identifier}>{identifier}</span>
                  </span>
                  <span className={styles.count}>
                    {pending === party.party ? 'bytter …' : `${party.dialogCount} dialoger`}
                  </span>
                </button>
              );
            })}

            {organizations.length > 0 && <div className={styles.group}>Virksomheter</div>}
            {organizations.map((party) => (
              <button type="button" key={party.party} className={styles.item} disabled>
                <span className={styles.name}>
                  {party.name}
                  <span className={styles.identifier}>{identifierOf(party.party)}</span>
                </span>
                <span className={styles.count}>{party.dialogCount} dialoger</span>
              </button>
            ))}

            {organizations.length > 0 && (
              <div className={styles.hint}>
                Du kan ikke logge inn som en virksomhet. De velges i partsvelgeren øverst.
              </div>
            )}
          </div>
        )}

        <button type="button" className={styles.toggle} onClick={() => setIsOpen(!isOpen)}>
          <span className={styles.badge}>dev</span>
          <span>{current?.name ?? currentPid ?? 'Bytt bruker'}</span>
        </button>
      </div>
    </>
  );
};
