---
'@swirl-search/backstage-plugin-search-backend-module-swirl': patch
---

Match the shapes the SWIRL service actually produces: hits are wrapped in
`<em>` and `</em>` rather than `*`, with the marker pair configurable through
`search.swirl.highlight.startMarker` and `endMarker`, and the provider score is
read from `payload.searchprovider_score`, where SWIRL's result processor moves
unrecognised top level keys.
