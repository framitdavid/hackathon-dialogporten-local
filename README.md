# Dialogporten lokalt

Kjører Dialogporten og arbeidsflate (Dialogporten frontend) helt lokalt, koblet mot
Altinn Studio LocalTest. Du starter en app i LocalTest, og instansen dukker opp som
utkast i innboksen med en lenke rett tilbake til utfyllingen.

```bash
./start.sh
```

Det er alt. Nettleseren åpnes ferdig innlogget.

## Forutsetninger

| | |
|---|---|
| Docker | OrbStack eller Docker Desktop |
| Node | 22 eller nyere |
| mkcert | `brew install mkcert nss && mkcert -install` |
| Altinn Studio | For LocalTest — kun nødvendig hvis du vil se appinstanser |

`mkcert -install` krever sudo og må kjøres én gang manuelt. Uten den får du en
sertifikatadvarsel i nettleseren, men alt annet virker.

## Hva som kjører

```
LocalTest (Altinn Studio)          :8000
        │  instansfiler
        ▼
sync-adapter/localtest-sync.mjs    watcher
        │  POST /api/v1/serviceowner/dialogs
        ▼
Dialogporten                       :7214 API, :7220 GraphQL
        │
        ▼
arbeidsflate BFF + frontend        https://app.localhost
```

## Testbrukere

Dialogporten validerer fødselsnummer med mod-11. Bare tre av LocalTest sine
personbrukere består:

| Party | Fødselsnummer | Navn | LocalTest UserId |
|---|---|---|---|
| 510001 | `01899699552` | Pengelens Partner | 1001 |
| 510002 | `17858296439` | Gjentagende Forelder | 1002 |
| 510003 | `08829698278` | Rik Forelder | 1003 |

Sophie Salt, Ola Nordmann, Kari Nordvik og MultiParty Prompt har fødselsnummer som
**ikke** består kontrollsifferet og blir avvist. Adapteren hopper over dem og sier ifra.

Standard er Pengelens Partner. Bytt uten å restarte noe:

```
https://app.localhost/api/login?pid=17858296439
```

Dialogporten leser pid-en rett av bearer-tokenet BFF sender, så hele stacken følger
etter umiddelbart. `./start.sh --pid <fnr>` setter startverdien i `.env`.

Husk å velge samme bruker i LocalTest — instansene må eies av den du ser innboksen til.

## Flyten

1. `./start.sh`
2. Start sync-adapteren i eget vindu: `node sync-adapter/localtest-sync.mjs --party 01899699552`
3. Logg inn i LocalTest som Pengelens Partner og start en app
4. Utkastet dukker opp i `https://app.localhost` innen sekundet
5. Klikk det → du er tilbake i utfyllingen

## Flagg

```
./start.sh --pid <fnr>     kjør som annen testbruker
./start.sh --no-open       ikke åpne nettleser
./start.sh --sync          start adapteren i forgrunnen til slutt
./start.sh --rebuild       bygg Dialogporten-imagene på nytt
```

Sync-adapteren: `--once`, `--dry-run`, `--verbose`, `--party <id>`.
Miljøvariabler: `DIALOGPORTEN_API`, `LOCALTEST_BASE`, `LOCALTEST_STORAGE`.

## Tilbake til innboks fra appen

Klikker du «tilbake til innboks» i en app, havner du i innboksen til den testbrukeren du
valgte som utfyller — på riktig dialog. Det krever to ting utenfor dette repoet.

**1. Appen må konfigureres.** I appens `App/appsettings.json`:

```json
"PlatformFrontendSettings": {
  "ArbeidsflateInboxUrl": "https://app.localhost/",
  "ArbeidsflateDialogUrl": "https://app.localhost/api/login?pid={pid}&goTo=/inbox/{dialogId}"
}
```

`{pid}` fylles med den valgte partens fødselsnummer, `{dialogId}` med dialogen
sync-adapteren opprettet. `/api/login` logger deg inn som den brukeren og sender deg
videre til dialogen.

**2. App-frontend må kjøres lokalt.** CDN-versjonen har ikke endringene. I
`altinn-studio/src/App/frontend`:

```bash
yarn start     # vite på :8080, som LocalTest allerede ruter til
```

Endringen i `src/utils/urls/urlHelper.ts` gjør at lokale verter følger konfigurerte
URL-er — men bare når URL-en selv peker lokalt. Konfigurerer du en URL mot tt02 eller
yt01, ignoreres den fortsatt, slik oppstrøms har bestemt.

**Sync-adapteren må kjøre.** Den skriver `dialog.id` inn i instansens `dataValues`, som
er der app-frontend henter dialog-ID-en fra. Er ikke adapteren i gang når du starter en
app, blir instansen aldri tagget, og lenken faller stille tilbake til LocalTests forside.

## Endringer mot oppstrøms

`dialogporten/` og `dialogporten-frontend/` er kopier av Altinn sine repoer med
lokale tilpasninger. De sporer ikke oppstrøms.

**dialogporten**

| Fil | Endring |
|---|---|
| `LocalDevelopmentUser.cs` (×2) | Løser pid per request: `pid`-claimet i bearer-tokenet, ellers `LocalDevelopment:Pid`, ellers innebygd standard. Gjør brukerbytte mulig uten omstart |
| `LocalDevelopmentAltinnAuthorization.cs` | Underenhetens orgnr `123456789` → `123456785`. Det opprinnelige består ikke mod-11, og arbeidsflate sender alle underenheter med i hvert dialogsøk — én ugyldig part gjør at `searchDialogs` returnerer `null`, altså tom innboks uten feilmelding |
| `FluentValidationStringExtensions.cs` | Godtar http for loopback og lokale verter, gated på `ASPNETCORE_ENVIRONMENT=Development`. LocalTest serverer apper over http og bygger redirect-URL-er fra Host-headeren, så den kan ikke stå bak en TLS-proxy |
| `docker-compose.override.yml` | Setter `LocalDevelopment__Pid` |

**dialogporten-frontend**

| Fil | Endring |
|---|---|
| `auth/oidc.ts` + `config.ts` | `/api/login` lager sesjonen direkte når `LOCAL_DEV_PID` er satt, i stedet for å redirecte til ID-porten. `?pid=<fnr>` bytter bruker |
| `compose.yml` | `oidc-static`-tjeneste, `extra_hosts` på bff, cert-mount, `NODE_EXTRA_CA_CERTS`, `LOCAL_DEV_PID` |
| `oidc-static/` | Statisk OIDC-discovery som BFF krever ved oppstart |

`FluentValidationStringExtensions.cs`- og `oidc.ts`-endringene er lokale bekvemmeligheter og
skal **ikke** merges oppstrøms.

## Hvordan innloggingen fungerer

Det finnes ingen ID-porten lokalt, og vi later heller ikke som. BFF-en startes med
`LOCAL_DEV_PID`, og da lager `/api/login` sesjonen direkte og setter cookien server-side
i stedet for å sende deg til en autorisasjonsserver som ikke finnes.

Det betyr at en manglende eller utløpt sesjon leger seg selv: du blir bare logget inn på
nytt. Det er verdt å vite at Redis-containeren ikke har noe volum, så alle sesjoner
forsvinner hver gang stacken rives ned.

BFF-en henter fortsatt `.well-known/openid-configuration` ved oppstart og nekter å starte
uten, så `oidc-static` serverer et statisk dokument. Endepunktene i det blir aldri kalt.

## Feilsøking

| Symptom | Årsak |
|---|---|
| Tom innboks | `LOCALTEST_PID` matcher ikke brukeren du logget inn som i LocalTest |
| Adapteren sier «hoppet over» | Testbrukerens fnr består ikke mod-11 |
| BFF crash-looper | `docker logs bff` — som regel at `oidc-static` ikke svarer |
| `docker compose up` klager på navnet `redis` | Altinn Studio designer holder navnet: `docker rm -f redis` (volumet beholdes) |
| Utkast vises ikke etter endring | Dialoglisten caches i 10 minutter — hard refresh |
| Sertifikatadvarsel | `sudo mkcert -install` |

## Rydde opp

```bash
./stop.sh              # stopper sync-adapteren og alle containere
./stop.sh --volumes    # og sletter databasevolumene
./stop.sh --keep-sync  # la adapteren stå
```

Adapteren stoppes først, slik at `fs.watch` slipper taket på instanskatalogen.
LocalTest og Altinn Studio røres ikke.
