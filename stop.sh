#!/usr/bin/env bash
#
# River ned det start.sh satte opp.
#
#   ./stop.sh              # stopper sync-adapteren og alle containere
#   ./stop.sh --volumes    # og sletter databasevolumene (alt av dialoger forsvinner)
#   ./stop.sh --keep-sync  # la sync-adapteren stå
#
# LocalTest og Altinn Studio røres ikke — de eies ikke av dette oppsettet.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$ROOT/dialogporten-frontend"
DIALOGPORTEN="$ROOT/dialogporten"

REMOVE_VOLUMES=0
STOP_SYNC=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --volumes|-v) REMOVE_VOLUMES=1; shift ;;
    --keep-sync) STOP_SYNC=0; shift ;;
    -h|--help) sed -n '2,/^[^#]/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Ukjent flagg: $1" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

# ------------------------------------------------------------------ sync-adapter

step "Sync-adapter"

if (( STOP_SYNC )); then
  # Så lenge prosessen lever holder fs.watch en referanse på instanskatalogen.
  pids=$(pgrep -f 'localtest-sync\.mjs' 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null
    sleep 1
    still=$(pgrep -f 'localtest-sync\.mjs' 2>/dev/null || true)
    if [[ -n "$still" ]]; then
      # shellcheck disable=SC2086
      kill -9 $still 2>/dev/null
      sleep 1
    fi
    if pgrep -f 'localtest-sync\.mjs' >/dev/null 2>&1; then
      warn "Klarte ikke stoppe adapteren — sjekk: pgrep -fl localtest-sync.mjs"
    else
      ok "Stoppet $(wc -w <<<"$pids" | tr -d ' ') prosess(er), fs.watch frigitt"
    fi
  else
    ok "Kjørte ikke"
  fi
else
  ok "Latt stå (--keep-sync)"
fi

# Ryddes uansett: den inneholder en sesjonscookie og gjenskapes ved neste start.
rm -f "$FRONTEND/.session-cookie"

# ------------------------------------------------------------------ arbeidsflate

DOWN_ARGS=(down --remove-orphans)
(( REMOVE_VOLUMES )) && DOWN_ARGS+=(--volumes)

step "Arbeidsflate"
if [[ -d "$FRONTEND" ]]; then
  ( cd "$FRONTEND" && docker compose "${DOWN_ARGS[@]}" ) 2>&1 | grep -vE '^time=|^$' | sed 's/^/  /'
  ok "Nede"
else
  warn "Fant ikke $FRONTEND"
fi

# ----------------------------------------------------------------- dialogporten

step "Dialogporten"
if [[ -d "$DIALOGPORTEN" ]]; then
  # Begge compose-filene deler prosjektnavn, så begge må med for å få alt ned.
  ( cd "$DIALOGPORTEN" && docker compose -f docker-compose.yml -f docker-compose-db-redis.yml "${DOWN_ARGS[@]}" ) \
    2>&1 | grep -vE '^time=|^$' | sed 's/^/  /'
  ok "Nede"
else
  warn "Fant ikke $DIALOGPORTEN"
fi

# ---------------------------------------------------------------------- status

step "Status"

leftover=$(docker ps --format '{{.Names}}' \
  --filter "label=com.docker.compose.project=dialogporten-frontend" \
  --filter "label=com.docker.compose.project=digdir" 2>/dev/null | tr '\n' ' ')
if [[ -n "${leftover// /}" ]]; then
  warn "Kjører fortsatt: $leftover"
else
  ok "Alle containere fra dette oppsettet er stoppet"
fi

untouched=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'localtest|designer' | tr '\n' ' ')
[[ -n "${untouched// /}" ]] && ok "Urørt (ikke vårt): ${untouched% }"

if (( REMOVE_VOLUMES )); then
  warn "Volumene er slettet — alle dialoger må synkes på nytt ved neste start"
else
  echo "  Databasevolumene er beholdt. Bruk --volumes for å slette dem også."
fi

echo
echo "  Start igjen med: ./start.sh"
