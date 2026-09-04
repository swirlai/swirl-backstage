---
'@swirl-search/backstage-plugin-search-backend-module-swirl': patch
---

Three fixes from the first outside-in smoke test of the published 0.1.0.

A search that matched nothing no longer answers HTTP 500. SWIRL reports a
document type with no live index either as a `404` carrying
`{"error": "missing_index", "types": [...]}` or as a soft `__MISSING_INDEX__`
entry in the response messages; the engine now throws `MissingIndexError` only
when that report covers every type the query asked for, measuring a query that
named no types against every type it has been handed an indexer for. A partial
miss is logged at debug and answered normally, with the results that came back
or an empty page if there were none. The everyday case this fixes is TechDocs
on a portal with no mkdocs content: the collator's zero-document abort
correctly leaves the type unindexed, and under `permission.enabled` the search
router puts it on every query, so any term with no matches came back as an
error page.

`search.swirl.tuning` is documented as nested camelCase only, which is the
shape `config.d.ts` declares and therefore the only shape that survives
`backstage-cli config:check --strict`. SWIRL also accepts its own flat
snake_case names on the same endpoint, and folds camelCase onto them, so
nothing is lost by writing camelCase. `tuning.bm25` stays in the schema so that
existing configs keep validating, now with a doc comment saying it is stored by
SWIRL and not applied by the current engine version, and the README example
says the same.

The README install section now says how to get past the Yarn 4 age gate that
`@backstage/create-app` ships (`npmMinimalAgeGate: 3d`), which refuses every
package published in the previous 72 hours: add `'@swirl-search/*'` to
`npmPreapprovedPackages`.
