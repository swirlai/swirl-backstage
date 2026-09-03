# swirl-backstage

SWIRL for Backstage: the npm side of the integration.

| Package | What it is |
| --- | --- |
| [`plugins/search-backend-module-swirl`](plugins/search-backend-module-swirl) | `@swirl-search/backstage-plugin-search-backend-module-swirl`, a Backstage search backend module that answers search from SWIRL and adds a `swirl-federated` document type for results from systems outside Backstage |

The service side (the SWIRL ingest API, the Backstage bearer verifier, the Tantivy index and the container image) lives in the SWIRL repositories.

## Layout

```
plugins/search-backend-module-swirl   the published npm package
e2e/stub-swirl                        a small in-memory stand-in for SWIRL, for local checks
```

## Working in this repo

```sh
yarn install
yarn test        # jest, all packages
yarn lint:all    # eslint
yarn tsc         # type check
yarn prettier:check
```

`yarn test` runs in watch mode when it detects a terminal; set `CI=true` for a single pass.

Every change to a published package needs a changeset:

```sh
yarn changeset
```

## Trying it against a real Backstage

Point a Backstage checkout at the package with a yarn portal and add the config block:

```sh
yarn --cwd packages/backend add \
  @swirl-search/backstage-plugin-search-backend-module-swirl@portal:/path/to/swirl-backstage/plugins/search-backend-module-swirl
```

```yaml
# app-config.local.yaml
search:
  swirl:
    baseUrl: http://localhost:8000
```

With no SWIRL running, start the stub instead:

```sh
node e2e/stub-swirl/server.js
```

## License

Apache 2.0. See [LICENSE](LICENSE).
