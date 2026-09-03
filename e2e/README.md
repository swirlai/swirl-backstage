# End to end

WP09. One command brings up a real SWIRL for Backstage container and a real
Backstage backend with the engine module wired in, then asserts on
`GET /api/search/query` - the same endpoint the Backstage search page calls.
Nothing here mocks SWIRL. `e2e/stub-swirl` is a different thing: a stand-in for
hand testing the engine module without a container, and this suite does not use
it.

```sh
yarn e2e
```

## What it starts

| Piece                         | Where                                                     | Port |
| ----------------------------- | --------------------------------------------------------- | ---- |
| `swirlai/swirl-backstage:dev` | `docker compose -f e2e/compose.yaml`, project `swirl-e2e` | 8011 |
| The e2e Backstage backend     | `e2e/app`, a trimmed create-app output                    | 7100 |
| The stub federated source     | `e2e/fixtures/stub-provider/server.js`, on the host       | 8012 |

Ports 8011 and 7100 rather than the usual 8000 and 7007 so the run can sit
beside a SWIRL and a Backstage you already have open. The brief for this package
said 8001; 8001 is where the QA lane's SWIRL listens on this machine, so the
container would not have bound.

The image has to be present locally. It is built from the SWIRL repository:

```sh
docker build --build-arg SWIRL_PROFILE=backstage -t swirlai/swirl-backstage:dev .
```

## What `yarn e2e` does

1. `docker compose -p swirl-e2e -f e2e/compose.yaml up -d`.
2. Waits for `GET http://localhost:8011/swirl/sapi/health/backstage/` to report
   `ok`, which means Redis, the Celery search worker and the Tantivy reader are
   all up.
3. Starts the stub federated source on 8012.
4. Runs `e2e/fixtures/register-provider.js`, which creates a `RequestsGet`
   SearchProvider named `Stub - E2E`, tagged `["backstage"]`, active, pointing
   at `http://host.docker.internal:8012/search`, through SWIRL's admin REST API
   with Basic auth.
5. Starts the Backstage backend from `e2e/app` on 7100, logging to
   `e2e/.logs/backend.log`.
6. Waits for `POST /api/auth/guest/refresh` to return a
   `backstageIdentity.token`, and for `GET /swirl/index/` to show
   `software-catalog` live with a document count, which means the catalog
   collator has pushed a generation into SWIRL and finalized it.
7. Runs jest with `e2e/jest.config.js`.
8. Tears all of it down, volume included.

`yarn e2e --keep` leaves everything running afterwards. `yarn e2e --no-up`
skips steps 1 to 6 and runs the assertions against a stack that is already up,
which is what you want while editing a test.

## The assertions

| File                        | What it asserts                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/gate-zero.test.js`   | The seven gate-zero cases from `reboot-design/gauntlet-results.md`, end to end: `tech`, `abac`, `foo-bar.com`, `store`, `mes`, `wayback`, `petsotre` |
| `tests/federated.test.js`   | A `swirl-federated` result located at the stub source appears; asking only for `software-catalog` leaves the federated lane out                      |
| `tests/filters.test.js`     | `kind=component` plus `lifecycle=production` returns only matching documents, and drops one the term alone would have kept                           |
| `tests/permissions.test.js` | The guest token shape, and that the query runs through `AuthorizedSearchEngine`                                                                      |
| `tests/restart.test.js`     | The container comes back, and the index is on disk                                                                                                   |

The files are not independent - the restart case takes the container down - so
`e2e/testSequencer.js` pins the order and `maxWorkers: 1` keeps them one at a
time.

### What the permission case does not prove

It proves the query goes through `AuthorizedSearchEngine`: after a search the
backend log carries a `POST /api/permission/authorize` line, and nothing else
in the search plugin calls the permission backend. It also proves the
`swirl-federated` type survives that wrapper, which is the reason the module
registers a collator that yields no documents at all.

It does **not** prove that two users see different results. create-app ships one
guest identity, no way to mint a second, and a policy that allows everything, so
there is no per-user filtering to observe. That needs a backend with a real
identity provider and a policy that returns a conditional decision, and it is
not tested here.

## Fixtures

`fixtures/catalog` is a copy of `packages/catalog-model/examples` from the
Backstage repository, plus `planted.yaml`. The example catalog carries
`petstore` and `wayback-search` but no `abacus`, no `foo-bar.com` and no
`tech-radar`, so the cases quoted from the Backstage search issues would have
nothing to find; `planted.yaml` adds them, along with three `*-service`
components for the filter case. WP00 planted the same entities into its
synthetic corpus, so the e2e assertions and `gauntlet-results.md` line up
document for document.

`acme-corp.yaml` brings in `team-a` through `team-d`, which is what the `tech`
case needs something to rank below.

## Known SWIRL-side defects, found by this suite

Both are in the SWIRL repository, not in this one. Neither is patched here.

### 1. The container does not survive a restart

`docker compose restart swirl` brings daphne and Redis back but not Celery, so
`/swirl/sapi/health/backstage/` stays on 503 forever and `/swirl/search/` has no
worker. `tests/restart.test.js` fails on this, on purpose.

The cause is a stale pid file. `docker/backstage/entrypoint.sh` calls
`python swirl.py start celery-worker celery-beats`, and `swirl.py` reads
`/app/.swirl`, which after a restart still holds the pids from the previous
container process tree:

```
$ docker exec swirl-e2e cat /app/.swirl
{"celery-worker": 41, "celery-beats": 54}

entrypoint: starting celery
  celery-worker is already running - remove .swirl if this is incorrect
```

`/app/.swirl` is in the container's writable layer, not on the `/data` volume,
so `docker compose up --force-recreate` clears it and a fresh container is fine.
A restart, and therefore also the `restart: unless-stopped` policy in the
shipped `docker/backstage/compose.yaml`, is not. The fix belongs in the
entrypoint: remove the file, or validate the pids in it, before starting Celery.

The second case in `tests/restart.test.js` recreates the container instead, on
the same volume, and asserts the live generation id is unchanged and `store`
still returns `petstore`. That is the property the restart case was written for,
and it holds: the index is genuinely on disk.

### 2. Two collators beginning a generation in the same instant wedge a type

With both collators on the same schedule they call
`POST /swirl/index/<type>/begin/` in the same instant. The second one gets an
HTTP 500 with a Django error page, from

```
sqlite3.OperationalError: database is locked
```

raised out of `SearchIndexGeneration.objects.get_or_create`. The generation
directory has already been created by then, so the type is left with an open
generation nobody will ever finalize, and every later `begin` gets a 409 until
`SWIRL_TANTIVY_BEGIN_TTL` (two hours) expires:

```
Collating documents for software-catalog failed: Error: SWIRL refused to open a
generation for software-catalog: HTTP 409 {"detail":"a generation is already
open for type \"software-catalog\": 20260903T195515-269297 (open for 30 s)"}
```

The workaround here is the 15 second gap between the two collator schedules in
`e2e/app/app-config.yaml`. A real fix is on the SWIRL side: the ingest views
need to hold the filesystem generation and the bookkeeping row together, and
SQLite needs WAL mode or a retry.

## Known plugin-side defect, found by this suite

The `search.swirl.tuning` block in `config.d.ts` is documented as nested
camelCase - `tuning.fuzzy.enabled`, `tuning.fieldBoosts.titleExact` - and
`SwirlSearchEngine.pushTuning` posts it to `POST /swirl/index/config/` verbatim.
SWIRL's `Tuning.from_dict` takes flat snake_case names and ignores every key it
does not recognise, so the documented block is accepted by Backstage and then
silently dropped:

```
$ curl -u admin:... -X POST http://localhost:8011/swirl/index/config/ \
    -d '{"fuzzy":{"enabled":true,"distance":1}}'
{... "fuzzy_enabled": false, "fuzzy_distance": 1 ...}

$ curl -u admin:... -X POST http://localhost:8011/swirl/index/config/ \
    -d '{"fuzzy_enabled":true}'
{... "fuzzy_enabled": true ...}
```

The `petsotre` gate-zero case needs `fuzzy_enabled`, so `e2e/app/app-config.yaml`
uses SWIRL's own key names. Either the engine module should translate the
documented shape into SWIRL's, or `config.d.ts` should describe the shape SWIRL
actually reads. Until one of those happens, every tuning value an operator sets
in the documented shape does nothing.

## Other observations

Federated result titles and bodies arrive with SWIRL's `<em>` highlight markers
inline in `document.title` and `document.text`, while `highlight.fields` stays
empty. Backstage renders the document text as plain text, so the markers show up
as literal `<em>`. The engine maps SWIRL's `title` and `body` straight through;
the highlight rewrite only looks at `title_hit_highlights` and
`body_hit_highlights`.

## The e2e app

`e2e/app` is `npx @backstage/create-app@latest --skip-install` output, name
`swirl-e2e`, trimmed to what the assertions need: no frontend package, no
scaffolder, no Kubernetes, no notifications, no signals, no MCP actions, no
proxy. What is left is auth with the guest provider, the catalog, techdocs,
permissions with the create-app allow-all policy, and search with the catalog
and techdocs collators.

The engine module is a `link:` dependency on
`../../../../plugins/search-backend-module-swirl`. `portal:` is what the root
README recommends for a normal app, and it works here too, but `link:` is what
the monorepo needs and using the same protocol in both places keeps one
explanation rather than two. `link:` does not install the linked package's own
dependencies, so they resolve out of this repository's `node_modules`, which is
what a wiring check wants.

`app-config.yaml` sets the backend to 7100, the app to 3100, guest auth,
`permission.enabled: true`, `search.swirl.baseUrl: http://localhost:8011`,
`search.swirl.federated.providerTags: ["backstage"]`, the catalog locations
above, and a collator schedule of every 30 seconds with a 5 second initial
delay, so a run does not spend ten minutes waiting for the first index.

SWIRL verifies the plugin tokens the search router mints against the backend's
own JWKS at
`http://host.docker.internal:7100/api/search/.backstage/auth/v1/jwks.json`,
which is what `SWIRL_BACKSTAGE_JWKS_URL` in `compose.yaml` points at. There is
no shared secret anywhere in this setup.

## Credentials

`compose.yaml` sets `SWIRL_ADMIN_PASSWORD` to `swirl-e2e-local`, overridable
with `SWIRL_E2E_ADMIN_PASSWORD`. It is a local test credential for a container
bound to 127.0.0.1 that is destroyed at the end of the run, and it is the only
credential in the whole suite.
