---
'@swirl-search/backstage-plugin-search-backend-module-swirl': minor
---

First release. Registers SWIRL as a Backstage search engine: collated documents
are indexed through the SWIRL generation lifecycle, queries are answered by
SWIRL with the caller's plugin token forwarded unchanged, and a `swirl-federated`
document type carries results from systems that are not in Backstage.
