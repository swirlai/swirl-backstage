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

| File                          | What it asserts                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/gate-zero.test.js`     | The seven gate-zero cases from `reboot-design/gauntlet-results.md`, end to end: `tech`, `abac`, `foo-bar.com`, `store`, `mes`, `wayback`, `petsotre`                                                                                               |
| `tests/federated.test.js`     | A `swirl-federated` result located at the stub source appears, with clean document text and populated highlight fields; asking only for `software-catalog` leaves the federated lane out                                                           |
| `tests/filters.test.js`       | `kind=component` plus `lifecycle=production` returns only matching documents, and drops one the term alone would have kept                                                                                                                         |
| `tests/missing-index.test.js` | B2 from the post-publish smoke test: a zero-hit query over `software-catalog` and `techdocs`, with techdocs legitimately unindexed, answers 200 with an empty page rather than 500; a query for `techdocs` alone still reports `MissingIndexError` |
| `tests/permissions.test.js`   | The guest token shape, and that the query runs through `AuthorizedSearchEngine`                                                                                                                                                                    |
| `tests/restart.test.js`       | The container comes back, and the index is on disk                                                                                                                                                                                                 |

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

## Defects this suite found, and where they were fixed

All four were found here and fixed in the SWIRL repository and in this one.
The assertions that used to fail on purpose now pass.

### 1. The container did not survive a restart

`docker compose restart swirl` brought daphne and Redis back but not Celery, so
`/swirl/sapi/health/backstage/` stayed on 503 forever and `/swirl/search/` had
no worker. The cause was a stale pid file: `swirl.py` writes `/app/.swirl` and
refuses to start a service named in it, and that file lives in the container's
writable layer, which a restart keeps:

```
$ docker exec swirl-e2e cat /app/.swirl
{"celery-worker": 41, "celery-beats": 54}

entrypoint: starting celery
  celery-worker is already running - remove .swirl if this is incorrect
```

Fixed in `docker/backstage/clear_stale_pids.sh`, called by the entrypoint
before `swirl.py start`. It removes `/app/.swirl` and celery beat's
`celerybeat.pid` without validating the pids, because a fresh container process
tree cannot have children of the previous run and container pids are reused.

### 2. Two collators beginning a generation in the same instant wedged a type

With both collators on the same schedule they called
`POST /swirl/index/<type>/begin/` in the same instant. The second got an HTTP
500 out of `sqlite3.OperationalError: database is locked`, raised from the
bookkeeping write after the generation directory and the OPEN lock already
existed, so the type was left with a generation nobody would finalize and every
later `begin` got a 409 until `SWIRL_TANTIVY_BEGIN_TTL` expired.

Fixed in `swirl/tantivy_index/generations.py` and `swirl/views_index.py`: the
OPEN lock is taken with an exclusive create before anything else exists on
disk, the bookkeeping row is written inside that lock in one transaction with a
short retry, and a write that still cannot land rolls the directory and the
lock back. The TTL also dropped from two hours to thirty minutes, and the
SearchIndexGeneration admin gained an action to clear a stale lock. The 15
second gap between the two collator schedules in `e2e/app/app-config.yaml`
stays, so this suite exercises the ordinary path; the race itself is covered by
SWIRL's own regression tests.

### 3. The documented tuning block was dropped by SWIRL

`config.d.ts` documents `search.swirl.tuning` as nested camelCase -
`tuning.fuzzy.enabled`, `tuning.fieldBoosts.titleExact` - and
`SwirlSearchEngine.pushTuning` posts it to `POST /swirl/index/config/`
verbatim. SWIRL's `Tuning.from_dict` read only flat snake_case names and
ignored the rest, so an operator's whole tuning block was accepted by Backstage
and then did nothing.

Fixed on the SWIRL side: `from_dict` accepts both shapes, rejects an unknown
key with a 400 that names it rather than dropping it, and answers with the
effective tuning plus `accepted_keys`. `bm25.k1` and `bm25.b` are accepted and
stored, but tantivy-py binds no BM25 parameters, so the response also carries
`"bm25": "not applied by this engine version"`. The engine logs `accepted_keys`
and that notice at startup, and warns with the rejected keys on a 400 without
failing the boot. `e2e/app/app-config.yaml` is back on the documented shape.

### 4. Federated results carried SWIRL's `<em>` markers in the document

Federated result titles and bodies arrived with SWIRL's highlight markers
inline in `document.title` and `document.text`, while `highlight.fields` stayed
empty. Backstage renders document text as plain text, so the markers showed up
on screen.

Fixed on both sides. SWIRL moves the marked up value into
`title_hit_highlights` / `body_hit_highlights` and leaves the plain fields
clean, on the Backstage path only. The engine strips the configured marker pair
out of a federated `document.title` and `document.text` defensively, since an
older SWIRL will not have done it. `tests/federated.test.js` asserts both.

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
`search.swirl.federated.providerTags: ["backstage"]`, the documented nested
`search.swirl.tuning` block, the catalog locations above, and a collator
schedule of every 30 seconds with a 5 second initial delay, so a run does not
spend ten minutes waiting for the first index.

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
