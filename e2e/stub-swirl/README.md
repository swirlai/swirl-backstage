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

| Route                                      | Behaviour                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /swirl/index/config/`                | stores the tuning block, echoes it back                                                                                                                                            |
| `POST /swirl/index/<type>/begin/`          | opens a generation, `409` if one is already open                                                                                                                                   |
| `POST /swirl/index/<type>/<gen>/docs/`     | appends a batch, `400` naming the offending index when a document is missing `title`, `text` or `location`                                                                         |
| `POST /swirl/index/<type>/<gen>/finalize/` | swaps the live generation, `400` on zero documents                                                                                                                                 |
| `POST /swirl/index/<type>/<gen>/abort/`    | drops the open generation, leaves the live one                                                                                                                                     |
| `DELETE /swirl/index/<type>/`              | drops the live generation                                                                                                                                                          |
| `GET /swirl/index/`                        | `{"types": [{type, live, doc_count, bytes, updated, open}, ...]}`                                                                                                                  |
| `GET /swirl/search/`                       | substring match, `404 missing_index` for a requested type with no live generation, plus one synthetic federated hit whenever a provider other than `backstage-index` was asked for |
| `GET /swirl/results/`                      | pages a stored result set                                                                                                                                                          |

Type names are validated against `^[a-z0-9-]{1,64}$`, as in the real ingest API.

Results match the shapes the real service produces: hits are wrapped in `<em>`
and `</em>`, and the provider score sits in `payload.searchprovider_score`,
where SWIRL's `MappingResultProcessor` puts it.
