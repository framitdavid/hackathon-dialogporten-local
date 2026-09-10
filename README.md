# Dialogporten lokalt

Kjør Dialogporten og arbeidsflate (Dialogporten frontend) på egen maskin, koblet mot
Altinn Studio LocalTest. Du starter et skjema i LocalTest, og instansen dukker opp som
utkast i innboksen — med en lenke rett tilbake til utfyllingen.

```bash
./start.sh     # alt opp, nettleser åpnes
./stop.sh      # alt ned igjen
```

## Hva dette er til for

Å se og teste **hele flyten mellom app og innboks** uten å deploye noe eller ha tilgang
til testmiljøene: at en dialog opprettes med riktig innhold og status, at den havner i
riktig innboks, at knappene virker begge veier, og hvordan endringer i arbeidsflate eller
Dialogporten slår ut i praksis.

Det er ikke et testmiljø for Altinn-plattformen som helhet, og ikke et sted å verifisere
autorisasjon, tilganger eller varsling — se tabellen under.

## Forutsetninger

| | |
|---|---|
| Docker | OrbStack eller Docker Desktop |
| Node | 22 eller nyere |
| mkcert | `brew install mkcert nss && sudo mkcert -install` |
| Altinn Studio | For LocalTest — kun nødvendig for å lage appinstanser |

`sudo mkcert -install` må kjøres én gang manuelt. Uten den får du sertifikatadvarsel i
nettleseren, men alt annet virker.

## Ekte kontra mocket

**Ekte produksjonskode** — de virkelige tjenestene, ikke attrapper:

| | |
|---|---|
| Dialogporten | Ekte backend, database, GraphQL og service owner-API |
| Arbeidsflate | Ekte frontend og BFF |
| Datamodellen | Dialoger, statuser, systemetiketter, transmisjoner, GUI-actions |
| Validering | Mod-11 på fnr og orgnr, UUIDv7, HTTPS-krav på lenker |
| Kryptering | Person-URN-er krypteres i BFF-svar, som i produksjon |
| LocalTest | Altinns egen lokale plattformemulator |

**Mocket eller erstattet** — her oppfører oppsettet seg ikke som produksjon:

| Hva | Lokalt | Konsekvens |
|---|---|---|
| ID-porten | `/api/login` lager sesjonen direkte | Ingen ekte pålogging, ingen sikkerhetsnivå |
| Autorisasjon | `UseLocalDevelopmentAltinnAuthorization` | Du er alltid autorisert, og ser kun deg selv pluss én fast underenhet |
| Tilgangsstyring | `DisableAuth` på API-et | Service owner-API-et er helt åpent |
| Ressursregister | `UseLocalDevelopmentResourceRegister` | Alle `urn:altinn:resource:*` godtas, metadata dikteres opp |
| Navneoppslag | `UseLocalDevelopmentNameRegister` | Parter heter `Local Party (<fnr>)`, ikke sitt ekte navn |
| Altinn-plattform | `PLATFORM_BASEURL` peker på død port | Profil, favoritter og varslingsadresser er tomme |
| Maskinporten | Ikke konfigurert | Brukernavn-oppslag og varslinger virker ikke |
| Feature flags | Azure App Configuration ikke satt | Innebygde standardverdier brukes |
| Organisasjonslogoer | `altinncdn.no` nås ikke | Avsendere vises uten logo |
| App → Dialogporten | Vår `sync-adapter/` | I produksjon gjør Dialogporten Adapter denne jobben |

Det siste er verdt å merke seg: **sync-adapteren finnes ikke i produksjon**. Der oppretter
apper dialoger gjennom Dialogporten Adapter. Vår adapter leser instansfiler fra LocalTest
og speiler dem, så flyten kan testes uten den delen av plattformen.

## Testbrukere

Dialogporten validerer fødselsnummer med mod-11. Bare tre av LocalTest sine personbrukere
består:

| Party | Fødselsnummer | Navn | LocalTest UserId |
|---|---|---|---|
| 510001 | `01899699552` | Pengelens Partner | 1001 |
| 510002 | `17858296439` | Gjentagende Forelder | 1002 |
| 510003 | `08829698278` | Rik Forelder | 1003 |

Sophie Salt, Ola Nordmann, Kari Nordvik og MultiParty Prompt avvises. Adapteren hopper
over instansene deres og sier ifra i loggen.

Organisasjoner synkes, men blir usynlige — autorisasjonsmocken gir deg bare deg selv og
én fast underenhet.

## Flyten

```
LocalTest :8000 ──► sync-adapter ──► Dialogporten :7214 ──► arbeidsflate
   instansfil        watcher           dialog                https://app.localhost
```

1. `./start.sh`
2. `node sync-adapter/localtest-sync.mjs --party 01899699552` i eget vindu
3. Logg inn i LocalTest som Pengelens Partner og start en app
4. Utkastet dukker opp i innboksen innen sekundet
5. Klikk det → tilbake i utfyllingen. «Tilbake til innboks» tar deg tilbake til dialogen

**Adapteren må kjøre.** Er den ikke i gang når du starter en app, får instansen aldri
`dialog.id`, og tilbakelenken faller stille tilbake til LocalTests forside.

Bytt bruker uten omstart: `https://app.localhost/api/login?pid=17858296439`. Velg samme
bruker i LocalTest — instansene må eies av den du ser innboksen til.

## Kommandoer

```
./start.sh --pid <fnr>     kjør som annen testbruker
./start.sh --no-open       ikke åpne nettleser
./start.sh --sync          start adapteren i forgrunnen til slutt
./start.sh --rebuild       bygg Dialogporten-imagene på nytt

./stop.sh --volumes        slett databasevolumene også
./stop.sh --keep-sync      la adapteren stå
```

Adapteren: `--once`, `--dry-run`, `--verbose`, `--party <id>`.
Miljø: `DIALOGPORTEN_API`, `LOCALTEST_BASE`, `LOCALTEST_STORAGE`.

| | |
|---|---|
| Innboks | https://app.localhost |
| GraphiQL | https://app.localhost/api/graphiql |
| Dialogporten | http://localhost:7214/swagger |
| LocalTest | http://local.altinn.cloud:8000 |

## Tilbake til innboks fra appen

Krever to ting utenfor dette repoet.

**Appen konfigureres** i `App/appsettings.json`, og må restartes etterpå:

```json
"PlatformFrontendSettings": {
  "ArbeidsflateInboxUrl": "https://app.localhost/",
  "ArbeidsflateDialogUrl": "https://app.localhost/api/login?pid={pid}&goTo=/inbox/{dialogId}"
}
```

`{pid}` fylles med den valgte partens fødselsnummer, `{dialogId}` med dialogen adapteren
opprettet.

**App-frontend kjøres lokalt** — CDN-versjonen mangler endringene:

```bash
cd altinn-studio/src/App/frontend && yarn start    # vite på :8080
```

## Endringer mot oppstrøms

`dialogporten/` og `dialogporten-frontend/` er kopier av Altinn sine repoer. De sporer
ikke oppstrøms.

**dialogporten**

| Fil | Endring |
|---|---|
| `LocalDevelopmentUser.cs` (×2) | Løser pid per request fra bearer-tokenet, ellers `LocalDevelopment:Pid`. Gjør brukerbytte mulig uten omstart |
| `LocalDevelopmentAltinnAuthorization.cs` | Orgnr `123456789` → `123456785`, som bestod ikke mod-11 og gjorde hele innboksen tom. Deterministisk `PartyUuid` og pid i partsnavnet |
| `FluentValidationStringExtensions.cs` | Godtar http for lokale verter, gated på `ASPNETCORE_ENVIRONMENT=Development` |
| `docker-compose.override.yml` | Setter `LocalDevelopment__Pid` |

**dialogporten-frontend**

| Fil | Endring |
|---|---|
| `auth/oidc.ts`, `config.ts` | `/api/login` lager sesjonen lokalt når `LOCAL_DEV_PID` er satt. `?pid=` bytter bruker, `?goTo=` styrer landing |
| `compose.yml` | `oidc-static`-tjeneste, `extra_hosts`, cert-mount, `NODE_EXTRA_CA_CERTS` |
| `oidc-static/` | Statisk OIDC-discovery, som BFF krever ved oppstart |

**altinn-studio**, utenfor dette repoet: `src/App/frontend/src/utils/urls/urlHelper.ts`
lar lokale verter følge konfigurerte arbeidsflate-URL-er — men bare når URL-en selv peker
lokalt, så oppstrøms-regelen om aldri å sende en lokal bruker til et deployet miljø består.

Endringene i `FluentValidationStringExtensions.cs` og `oidc.ts` er lokale bekvemmeligheter
og skal **ikke** merges oppstrøms.

## Feilsøking

| Symptom | Årsak |
|---|---|
| Tom innboks | Brukeren i LocalTest matcher ikke den du er logget inn som |
| Adapteren sier «hoppet over» | Testbrukerens fnr består ikke mod-11 |
| Tilbakelenken mangler dialog | Adapteren kjørte ikke da instansen ble laget |
| Havner på en OIDC-side | `LOCAL_DEV_PID` nådde ikke containeren: `docker compose up -d --force-recreate bff` |
| BFF crash-looper | `docker logs bff` — som regel at `oidc-static` ikke svarer |
| Konflikt på navnet `redis` | Altinn Studio designer holder det: `docker rm -f redis` (volumet beholdes) |
| Utkast vises ikke etter endring | Dialoglisten caches i 10 minutter — hard refresh |
| Sertifikatadvarsel | `sudo mkcert -install` |

Dialogportens database er flyktig — den har ikke noe volum, så alle dialoger synkes på
nytt ved hver oppstart.
