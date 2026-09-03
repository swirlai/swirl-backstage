# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Report it privately through GitHub's advisory form for this repository, at
https://github.com/swirlai/swirl-backstage/security/advisories/new, or by email
to security@swirl.today.

Please include the affected version, what an attacker can do with the flaw, and
the smallest reproduction you have. You will get an acknowledgement within three
working days and an assessment within ten.

## What this package handles

The module is a client. It never stores credentials and it never mints identity
of its own. Two things pass through it and are worth knowing about:

- **Backstage plugin tokens.** The search router mints a short lived ES256 JWT
  for each query, carrying the calling user in its `obo` claim, and the module
  forwards it to SWIRL unchanged in an `Authorization` header. SWIRL verifies it
  against the Backstage JWKS. The module does not log tokens, cache them, or
  send them anywhere but the configured `search.swirl.baseUrl`.
- **Indexed documents.** Whatever your collators produce is posted to SWIRL. If a
  collator emits a secret, that secret reaches SWIRL. Audit collators, not this
  module, for that class of problem.

Point `search.swirl.baseUrl` at a host you control, over TLS outside a trusted
network. A hostile SWIRL sees every query, every indexed document, and every
plugin token the backend sends it.

## Supported versions

The most recent minor release receives security fixes.
