# stub-swirl

A stand-in for SWIRL, for driving the engine module by hand before the real
image exists. It holds documents in memory, matches by substring, and ranks by
insertion order. It is not a relevance test and it is not a security test: it
accepts any bearer token without verifying it, and it forgets everything on
restart.

```sh
node e2e/stub-swirl/server.js        # http://localhost:8000
PORT=8080 node e2e/stub-swirl/server.js
```

Point a Backstage backend at it with:

```yaml
search:
  swirl:
    baseUrl: http://localhost:8000
```

## What it serves

| Route                                      | Behaviour                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /swirl/index/config/`                | stores the tuning block, echoes it back                                                                                                                                                           |
| `POST /swirl/index/<type>/begin/`          | opens a generation, `409` if one is already open                                                                                                                                                  |
| `POST /swirl/index/<type>/<gen>/docs/`     | appends a batch, `400` naming the offending index when a document is missing `title`, `text` or `location`                                                                                        |
| `POST /swirl/index/<type>/<gen>/finalize/` | swaps the live generation, `400` on zero documents                                                                                                                                                |
| `POST /swirl/index/<type>/<gen>/abort/`    | drops the open generation, leaves the live one                                                                                                                                                    |
| `DELETE /swirl/index/<type>/`              | drops the live generation                                                                                                                                                                         |
| `GET /swirl/index/`                        | `{"types": [{type, live, doc_count, bytes, updated, open}, ...]}`                                                                                                                                 |
| `GET /swirl/search/`                       | substring match, a missing index report for a requested type with no live generation (see below), plus one synthetic federated hit whenever a provider other than `backstage-index` was asked for |
| `GET /swirl/results/`                      | pages a stored result set                                                                                                                                                                         |

Type names are validated against `^[a-z0-9-]{1,64}$`, as in the real ingest API.

## Missing index, both forms

SWIRL has two ways of saying that a requested type has no live index, and the
engine has to handle both, so the stub can produce either:

| Form   | What comes back                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `hard` | `404` with body `{"error": "missing_index", "types": [...]}`, and no results at all                                                |
| `soft` | `200`, with `{"type": "__MISSING_INDEX__", "types": [...]}` as a JSON string in `messages`, beside whatever the live types matched |

`hard` is the default. Switch forms for the whole process, or for one request:

```sh
STUB_SWIRL_MISSING_INDEX_FORM=soft node e2e/stub-swirl/server.js
```

```
GET /swirl/search/?qs=petstore&backstage_types=software-catalog,techdocs&stub_missing_index=soft
```

The per-request parameter is for driving the stub by hand with `curl`; the
engine never sends it, so point a backend at a stub started with the
environment variable when you want the soft form through Backstage.

Results match the shapes the real service produces: hits are wrapped in `<em>`
and `</em>`, and the provider score sits in `payload.searchprovider_score`,
where SWIRL's `MappingResultProcessor` puts it.
