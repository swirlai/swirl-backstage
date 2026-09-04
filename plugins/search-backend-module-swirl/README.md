# search-backend-module-swirl

A Backstage search backend module that puts [SWIRL](https://github.com/swirlai/swirl-search) behind the search plugin.

## What it does

The module registers two things with the search backend:

1. **A search engine.** Every document Backstage collates (catalog entities, TechDocs pages, anything else with a collator) is written to a SWIRL index instead of Lunr, Postgres or Elasticsearch, and every query is answered by SWIRL. Backstage keeps its own result rendering and its own permission filtering; only storage and relevance move.
2. **A `swirl-federated` document type.** SWIRL can fan a query out to systems that are not in Backstage at all - GitHub, Confluence, an internal wiki, a ticket tracker. Those results come back in the same response, under the `swirl-federated` type, and land in the normal search page next to catalog results. The type is declared by a collator that yields zero documents; nothing federated is ever indexed by Backstage.

Identity travels with the query. The search router mints a plugin token for each request whose `obo` claim carries the calling user, and the module forwards that token to SWIRL unchanged, so SWIRL applies the same user's access to the sources it federates to.

## Install

### First, allow the scope in `.yarnrc.yml`

A fresh `@backstage/create-app` ships this:

```yaml
# .yarnrc.yml, as create-app writes it
nodeLinker: node-modules
npmMinimalAgeGate: 3d
npmPreapprovedPackages:
  - '@backstage/*'
```

`npmMinimalAgeGate: 3d` is a Yarn 4 supply-chain control that refuses any
package published in the last 72 hours unless its scope is preapproved. For the
first three days after every release of this package, `yarn add` fails with
`YN0016: All versions satisfying "x.y.z" are quarantined`, whether or not you
pin the version. Add the scope:

```yaml
# .yarnrc.yml
nodeLinker: node-modules
npmMinimalAgeGate: 3d
npmPreapprovedPackages:
  - '@backstage/*'
  - '@swirl-search/*'
```

Preapproving the scope is the Backstage-native escape hatch. Do not set
`npmMinimalAgeGate: 0`; that turns the control off for every package in the
repository.

### Then install

```sh
# from your Backstage root
yarn --cwd packages/backend add @swirl-search/backstage-plugin-search-backend-module-swirl
```

Add it to the backend, after the search plugin:

```ts
// packages/backend/src/index.ts
backend.add(import('@backstage/plugin-search-backend'));
backend.add(
  import('@swirl-search/backstage-plugin-search-backend-module-swirl'),
);
```

If your backend loads search modules conditionally, guard on the config key so the app still boots without SWIRL:

```ts
if (config.has('search.swirl')) {
  yield import('@swirl-search/backstage-plugin-search-backend-module-swirl');
}
```

The module also skips registration on its own, with a logged warning, when `search.swirl` is absent. Your existing engine stays in place.

## Configuration

```yaml
search:
  swirl:
    # The only required key.
    baseUrl: http://swirl:8000

    # Backstage plugin id whose JWKS SWIRL trusts. Default "search".
    audience: search

    # Documents per ingest request. Default 500.
    indexerBatchSize: 500

    # Query timeout in ms. Default 8000.
    queryTimeoutMs: 8000

    federated:
      # Register the swirl-federated document type. Default true.
      enabled: true
      # SWIRL provider tags to fan out to. Default ["backstage"].
      providerTags: [backstage]
      # Per-query federation timeout in ms, passed to SWIRL. Default 5000.
      timeoutMs: 5000

    # Relevance tuning, mirrored to SWIRL on startup. Nested camelCase, which
    # is the only shape config.d.ts accepts; see the note below the block.
    tuning:
      fieldBoosts:
        titleExact: 3
        titleNgram: 2
        text: 1
      ngram:
        min: 4
        max: 5
      stemmer: en
      stopwords: []
      fuzzy:
        enabled: true
        distance: 1
      # Stored by SWIRL, not applied by the current engine version. Setting it
      # changes no ranking; the module logs a warning at startup saying so.
      bm25:
        k1: 1.2
        b: 0.75

    highlight:
      # Default true.
      enabled: true
      # Longest snippet returned per field, counted in visible characters
      # rather than markup. Default 200.
      maxChars: 200
      # The marker pair SWIRL wraps hits in, from its
      # SWIRL_HIGHLIGHT_START_CHAR and SWIRL_HIGHLIGHT_END_CHAR settings.
      # Override both together if your SWIRL differs from the defaults.
      startMarker: <em>
      endMarker: </em>
```

The whole block is `@visibility backend`; none of it reaches the browser.

### Write the tuning keys in camelCase

SWIRL accepts both the nested camelCase names above and its own flat
snake_case names (`title_exact_boost`, `ngram_min`, `fuzzy_enabled` and the
rest) on the tuning endpoint. This package's `config.d.ts` declares only the
camelCase shape, so a repository that runs `backstage-cli config:check
--strict` - standard Backstage practice, and standard in CI - rejects the flat
names:

```
Config must NOT have additional properties { additionalProperty=title_exact_boost } at /search/swirl/tuning
```

Write camelCase. SWIRL folds those names onto its own before applying them, so
nothing is lost, and the engine logs the keys SWIRL accepted at startup.

## How it talks to SWIRL

### Indexing

One generation per collator run, per document type:

| Call                                       | When                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `POST /swirl/index/<type>/begin/`          | the indexer opens                                                                             |
| `POST /swirl/index/<type>/<gen>/docs/`     | once per batch, retried three times with backoff on 5xx and transport errors                  |
| `POST /swirl/index/<type>/<gen>/finalize/` | at the end of a run that produced at least one document; swaps the live generation atomically |
| `POST /swirl/index/<type>/<gen>/abort/`    | a run that produced zero documents, or one that failed anywhere in the pipeline               |

The zero-document abort is the guard every Backstage engine needs: a collator that comes back empty must not wipe the index that is currently being served. Because a failed run aborts its own generation rather than half-writing the live one, a crashed collator leaves search working on the last good index.

### Querying

Page 0 federates:

```
GET /swirl/search/?qs=<term>&providers=<tags>&backstage_types=<types>&backstage_filters=<json>&rag=false
```

Page N is a database read in SWIRL, not a second federation, which keeps the paging loop in Backstage's `AuthorizedSearchEngine` cheap:

```
GET /swirl/results/?search_id=<id>&page=<n>
```

Both carry `Authorization: Bearer <plugin token>`. The page cursor Backstage passes around is base64 JSON, `{ "s": <swirl search id>, "p": <page> }`.

The federated lane joins a query when the caller asked for no types at all, or named `swirl-federated`. Under `permission.enabled` the router always passes the full list of registered types, which is exactly why the type has to be registered.

### Startup

On startup the module posts the `tuning` block to `POST /swirl/index/config/`, so relevance is configured in app-config and mirrored into SWIRL rather than maintained twice. A SWIRL that is down, or one that does not know the endpoint, is logged and stepped over; it never stops the backend from booting.

### Errors

SWIRL reports a type with no live index either as a `404` whose body is `{"error": "missing_index", "types": [...]}`, or as a structured `{"type": "__MISSING_INDEX__", "types": [...]}` entry in the response `messages` array. The engine treats the two forms the same way, and what it does with them depends on how much of the query the report accounts for:

- **Every type the query asked for is missing.** The engine throws an error named `MissingIndexError`, so the cause is visible instead of looking like a query that simply matched nothing. A query that named no types is measured against every type the search backend has handed this engine an indexer for.
- **Only some of them are missing.** The engine logs at debug and answers normally: the results that did come back if there are any, an empty page if there are not.

The second case is the ordinary one on a real portal. A type can be legitimately and permanently empty - TechDocs on a portal with no mkdocs content is the everyday example, where the collator's zero-document abort correctly leaves it unindexed - and under `permission.enabled` the search router puts every registered type on every query. A search that matches nothing has to come back as "no results", not as an error page.

## Highlighting

SWIRL marks hits in `title_hit_highlights` and `body_hit_highlights` with `<em>` and `</em>`, from its `SWIRL_HIGHLIGHT_START_CHAR` and `SWIRL_HIGHLIGHT_END_CHAR` settings. The engine rewrites those markers to a random per-instance tag pair before handing results to Backstage, the same way the Postgres engine does, so a document body containing a literal `<em>` cannot forge a highlight. A SWIRL configured with a different pair is handled by `highlight.startMarker` and `highlight.endMarker`.

`maxChars` budgets visible characters, not markup, and a snippet cut short inside a hit still closes it, so the engine never hands Backstage an unbalanced tag.

## Scores

SWIRL's `MappingResultProcessor` sweeps top level keys it does not recognise into `payload`, so the provider score arrives as `payload.searchprovider_score` rather than beside `swirl_score`. The engine reads it from there and falls back to `swirl_score`.

Ranks stay sequential in the order SWIRL returned, because the relevancy mixer has already ordered results across providers; the engine does not re-sort by score. The score is attached to `swirl-federated` documents as `score`, where it is the only ranking signal a renderer has. Indexed documents are handed back exactly as Backstage collated them.

## Development

```sh
yarn test
yarn lint
yarn tsc
```

`e2e/stub-swirl/` in the repository root serves the six endpoints this module calls, backed by an in-memory index, for manual checks without a SWIRL container.
