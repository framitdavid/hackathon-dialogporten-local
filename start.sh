#!/usr/bin/env bash
#
# Setter opp hele den lokale Dialogporten-stacken og åpner innboksen.
#
#   ./start.sh                      # alt opp, nettleser åpnes
#   ./start.sh --pid 17858296439    # kjør som en annen LocalTest-testbruker
#   ./start.sh --no-open            # ikke åpne nettleser
#   ./start.sh --no-sync            # ikke bli stående med sync-adapteren
#   ./start.sh --rebuild            # bygg Dialogporten-imagene helt på nytt
#
# Forutsetter Docker, Node 22+, mkcert og Altinn Studio (for LocalTest).
#
set -euo pipefail

# set -e avslutter uten et ord hvis en kommando feiler. Denne fellen sørger for at
# scriptet alltid sier hvor det stoppet — en stille død er nesten umulig å feilsøke.
trap 'code=$?; if (( code )); then printf "\n\033[31m✗ Avbrutt på linje %s (exit %s)\033[0m\n" "$LINENO" "$code" >&2; fi' EXIT

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$ROOT/dialogporten-frontend"
DIALOGPORTEN="$ROOT/dialogporten"
SYNC="$ROOT/sync-adapter"

LOCALTEST_PID="${LOCALTEST_PID:-01899699552}"
OPEN_BROWSER=1
RUN_SYNC=1
REBUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pid) LOCALTEST_PID="$2"; shift 2 ;;
    --no-open) OPEN_BROWSER=0; shift ;;
    --no-sync) RUN_SYNC=0; shift ;;
    --sync) shift ;;  # nå standard, beholdt for vane
    --rebuild) REBUILD=1; shift ;;
    -h|--help) sed -n '2,/^[^#]/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Ukjent flagg: $1" >&2; exit 1 ;;
  esac
done

step()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# wait_for <sekunder> <beskrivelse> <kommando...>
wait_for() {
  local timeout=$1 desc=$2; shift 2
  local waited=0
  until "$@" >/dev/null 2>&1; do
    if (( waited >= timeout )); then return 1; fi
    sleep 2
    waited=$((waited + 2))
    if (( waited % 20 == 0 )); then printf '    venter på %s (%ss)\n' "$desc" "$waited"; fi
  done
}

# ---------------------------------------------------------------- forutsetninger

step "Sjekker forutsetninger"

docker info >/dev/null 2>&1 || die "Docker kjører ikke. Start Docker eller OrbStack og prøv igjen."
ok "Docker"

command -v node >/dev/null 2>&1 || die "Node mangler. Installer Node 22 eller nyere."
ok "Node $(node -v)"

[[ -d "$DIALOGPORTEN" && -d "$FRONTEND" ]] || die "Mangler dialogporten/ eller dialogporten-frontend/ i $ROOT"
ok "Kildekode på plass"

if ! curl -sf -o /dev/null --max-time 3 http://localhost:8000/ 2>/dev/null; then
  warn "LocalTest svarer ikke på :8000 — start Altinn Studio hvis du vil se appinstanser"
else
  ok "LocalTest på :8000"
fi

# ------------------------------------------------------------------------ .env

step "Konfigurasjon"

if [[ ! -f "$FRONTEND/.env" ]]; then
  # PERSON_URN_ENC_KEYS krypterer person-URN-er i BFF-svar. Tom verdi gir kast ved
  # import i party/personUrnCipher.ts, altså crash-loop. Genereres per maskin og
  # committes aldri.
  KEY=$(openssl rand -base64 64 | tr -d '\n')
  sed -e "s|__PERSON_URN_ENC_KEYS__|$KEY|" -e "s|__LOCAL_DEV_PID__|$LOCALTEST_PID|" \
    "$ROOT/env.template" > "$FRONTEND/.env"
  ok "Genererte .env med ny krypteringsnøkkel"
else
  ok ".env finnes"
fi

# Compose leser .env selv, så innloggingen overlever et hvilket som helst
# `docker compose up` — også et kjørt for hånd uten miljøvariabler satt.
if grep -q '^LOCAL_DEV_PID=' "$FRONTEND/.env"; then
  sed -i '' "s|^LOCAL_DEV_PID=.*|LOCAL_DEV_PID=$LOCALTEST_PID|" "$FRONTEND/.env"
else
  printf '\nLOCAL_DEV_PID=%s\n' "$LOCALTEST_PID" >> "$FRONTEND/.env"
fi
ok "Lokal innlogging som $LOCALTEST_PID"

# ------------------------------------------------------------------ sertifikater

step "Sertifikater"

CERT_HOSTS=(app.localhost localhost docs.localhost dashboard.localhost
            pgadmin4.localhost redisinsight.localhost oidc-static.localhost)

# Katalogen er tom i git (oppstrøms .gitignore har certs/*), så den finnes ikke etter
# en fersk klone. Uten den feiler mkcert med "no such file or directory".
mkdir -p "$FRONTEND/certs"

if [[ ! -f "$FRONTEND/certs/cert.pem" || ! -f "$FRONTEND/certs/key.pem" ]]; then
  command -v mkcert >/dev/null 2>&1 || die "mkcert mangler. Kjør: brew install mkcert nss && sudo mkcert -install"
  if ! cert_log=$( cd "$FRONTEND" && mkcert -cert-file certs/cert.crt -key-file certs/key.pem "${CERT_HOSTS[@]}" 2>&1 ); then
    printf '%s\n' "$cert_log" | sed 's/^/    /' >&2
    die "mkcert klarte ikke lage sertifikat"
  fi
  if ! openssl_log=$( openssl x509 -in "$FRONTEND/certs/cert.crt" -out "$FRONTEND/certs/cert.pem" -outform PEM 2>&1 ); then
    printf '%s\n' "$openssl_log" | sed 's/^/    /' >&2
    die "openssl klarte ikke konvertere sertifikatet"
  fi
  ok "Genererte sertifikat for ${#CERT_HOSTS[@]} navn"
else
  ok "Sertifikat finnes"
fi

# BFF henter OIDC-discovery over HTTPS ved oppstart og må stole på mkcert-CA-en.
if [[ ! -f "$FRONTEND/certs/rootCA.pem" ]] && command -v mkcert >/dev/null 2>&1; then
  caroot=$(mkcert -CAROOT 2>/dev/null || true)
  if [[ -n "$caroot" && -f "$caroot/rootCA.pem" ]]; then
    cp "$caroot/rootCA.pem" "$FRONTEND/certs/"
    ok "Kopierte mkcert rot-CA"
  else
    warn "Fant ingen rot-CA i ${caroot:-ukjent CAROOT} — kjør: sudo mkcert -install"
  fi
fi
[[ -f "$FRONTEND/certs/rootCA.pem" ]] || warn "certs/rootCA.pem mangler — BFF klarer neppe å starte"

if command -v mkcert >/dev/null 2>&1 && ! security find-certificate -c "mkcert" /Library/Keychains/System.keychain >/dev/null 2>&1; then
  warn "mkcert-CA-en ligger ikke i systemets trust store — nettleseren vil advare."
  warn "Fiks:  sudo mkcert -install"
fi

CURL_CA=(--cacert "$FRONTEND/certs/rootCA.pem")

# ----------------------------------------------------------------- dialogporten

step "Starter Dialogporten"

(
  cd "$DIALOGPORTEN"
  [[ -f .env ]] || cp "$ROOT/dialogporten-env.template" .env
  LOCALTEST_PID="$LOCALTEST_PID" docker compose -f docker-compose-db-redis.yml up -d >/dev/null 2>&1
  if (( REBUILD )); then
    LOCALTEST_PID="$LOCALTEST_PID" docker compose build --no-cache dialogporten-graphql dialogporten-webapi >/dev/null 2>&1
  fi
  LOCALTEST_PID="$LOCALTEST_PID" docker compose up -d dialogporten-graphql dialogporten-webapi dialogporten-webapi-ingress >/dev/null 2>&1
)
ok "Containere startet"

dp_ready() {
  curl -sf -X POST http://localhost:7220/graphql -H 'Content-Type: application/json' \
    -d '{"query":"{ parties { party } }"}' | grep -q '"parties"'
}
wait_for 300 "Dialogporten GraphQL" dp_ready \
  || die "Dialogporten svarte ikke. Første bygg tar noen minutter — se: docker logs digdir-dialogporten-graphql-1"
ok "GraphQL på :7220"

wait_for 180 "Dialogporten WebApi" curl -sf -o /dev/null "http://localhost:7214/health" \
  || warn "WebApi (:7214) svarer ikke — sync-adapteren vil feile"
ok "WebApi på :7214"

ACTIVE_PID=$(curl -s -X POST http://localhost:7220/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ parties { party } }"}' | sed -n 's/.*person:identifier-no:\([0-9]*\).*/\1/p')
if [[ "$ACTIVE_PID" == "$LOCALTEST_PID" ]]; then
  ok "Autentisert part: $ACTIVE_PID"
else
  warn "Dialogporten kjører som ${ACTIVE_PID:-ukjent}, du ba om $LOCALTEST_PID — prøv --rebuild"
fi

# ------------------------------------------------------------------ arbeidsflate

step "Starter arbeidsflate"

if docker ps -a --format '{{.Names}}' | grep -qx redis; then
  owner=$(docker inspect redis --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || echo "")
  if [[ -n "$owner" && "$owner" != "dialogporten-frontend" ]]; then
    die "Containernavnet 'redis' er tatt av prosjektet '$owner'. Fjern den med: docker rm -f redis (volumet beholdes)"
  fi
fi

# --build er nødvendig: uten den gjenbruker compose et eksisterende image i det
# uendelige. Et bff-image fra et tidligere forsøk kjenner da ikke LOCAL_DEV_PID,
# og du havner i OIDC-flyten selv om containeren har variabelen. Bygget er nesten
# gratis når kilden er uendret.
if ! fe_log=$( cd "$FRONTEND" && docker compose up -d --build 2>&1 ); then
  printf '%s\n' "$fe_log" | tail -20 | sed 's/^/    /' >&2
  die "docker compose up feilet i $FRONTEND"
fi
ok "Containere startet"

bff_ready() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "${CURL_CA[@]}" https://app.localhost/api/isAuthenticated || echo 000)
  [[ "$code" == "401" || "$code" == "200" ]]
}
wait_for 300 "BFF" bff_ready || die "BFF svarte ikke. Se: docker logs bff"
ok "BFF på https://app.localhost/api"

wait_for 180 "frontend" curl -sf -o /dev/null "${CURL_CA[@]}" https://app.localhost/ \
  || warn "Frontend svarte ikke ennå — Vite bruker litt tid første gang"

# ---------------------------------------------------------------------- sesjon

step "Innlogging"

# Ingen ID-porten lokalt. BFF-en er startet med LOCAL_DEV_PID, så /api/login lager
# sesjonen direkte og setter cookien server-side i stedet for å sende brukeren videre
# til en autorisasjonsserver som ikke finnes. En utløpt eller slettet sesjon leger seg
# dermed selv ved neste kall — Redis-sesjonene forsvinner hver gang stacken rives ned.
# Leser Location-headeren direkte. %{redirect_url} kan ikke brukes: eldre curl lar
# den stå tom ved relativ redirect, og da ville sjekken meldt feil selv om
# innloggingen fungerer. Lokal innlogging sender til "/", OIDC-flyten til /authorize.
login_ok() {
  local location
  location=$(curl -s -D - -o /dev/null "${CURL_CA[@]}" https://app.localhost/api/login 2>/dev/null \
    | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
  [[ -n "$location" && "$location" != *"/authorize"* ]]
}

if wait_for 60 "innlogging" login_ok; then
  ok "/api/login logger inn som $LOCALTEST_PID uten ID-porten"
else
  # Docker compose gjenskaper ikke en container når bare .env har endret seg, så en
  # bff fra et tidligere forsøk kan sitte igjen uten LOCAL_DEV_PID. Symptomet er at du
  # sendes til en OIDC-side som ikke finnes. Tving fram en ny container og prøv igjen.
  warn "/api/login peker på OIDC — gjenskaper bff med riktig miljø"
  ( cd "$FRONTEND" && docker compose up -d --force-recreate bff >/dev/null 2>&1 ) || true
  wait_for 180 "BFF" bff_ready || true

  if wait_for 60 "innlogging" login_ok; then
    ok "/api/login logger inn som $LOCALTEST_PID uten ID-porten"
  else
    warn "Innloggingen virker fortsatt ikke. Sjekk at variabelen nådde containeren:"
    warn "  docker exec bff sh -c 'echo \$LOCAL_DEV_PID'   (skal gi $LOCALTEST_PID)"
    warn "  grep LOCAL_DEV_PID $FRONTEND/.env"
  fi
fi

INSTANCE_DIR="$HOME/Library/Application Support/altinn-studio/data/AltinnPlatformLocal/documentdb/instances"

# Watcheren synker alt ved oppstart, så en egen --once-runde her ville bare gjort
# jobben to ganger. Den kjøres derfor kun når vi ikke blir stående med watcheren.
if [[ ! -d "$INSTANCE_DIR" ]]; then
  step "Synker LocalTest-instanser"
  warn "Fant ikke LocalTest-lagringen — hopper over sync. Kjører Altinn Studio?"
  RUN_SYNC=0
elif (( ! RUN_SYNC )); then
  step "Synker LocalTest-instanser"
  node "$SYNC/localtest-sync.mjs" --once --party "$LOCALTEST_PID" 2>&1 \
    | grep -vE '^(Dialogporten|LocalTest|Partsfilter) ' || true
fi

# ---------------------------------------------------------------------- ferdig

step "Klart"
cat <<EOF
  Innboks      https://app.localhost
  GraphiQL     https://app.localhost/api/graphiql
  LocalTest    http://local.altinn.cloud:8000
  Dialogporten http://localhost:7214/swagger

  Testbruker   $LOCALTEST_PID
EOF

if (( OPEN_BROWSER )); then
  open "https://app.localhost/" 2>/dev/null && ok "Åpnet nettleser" \
    || warn "Åpne https://app.localhost/ manuelt"
fi

if (( RUN_SYNC )); then
  # Watcheren må stå på for at nye instanser skal få dialog.id — uten den faller
  # «tilbake til innboks» stille tilbake til LocalTests forside. Derfor standard.
  # exec erstatter skallet, så EXIT-fellen fyrer ikke på et vanlig Ctrl+C.
  step "Sync-adapter kjører — Ctrl+C for å avslutte"
  exec node "$SYNC/localtest-sync.mjs" --party "$LOCALTEST_PID"
fi

warn "Sync-adapteren kjører ikke (--no-sync). Nye instanser får ikke dialog.id."
echo "  Start den med: node sync-adapter/localtest-sync.mjs --party $LOCALTEST_PID"
