# swirl-e2e

The Backstage app the end to end suite runs against. `npx
@backstage/create-app@latest --skip-install` output, trimmed to what the
assertions need: the backend only, with auth (guest), the catalog, techdocs,
permissions and search, and the SWIRL engine module in place of the create-app
default engine.

Do not start it by hand for a test run. `yarn e2e` from the repository root
brings up the SWIRL container and the stub federated source first, and this
backend is useless without them. See [../README.md](../README.md).

To poke at it while the rest of the stack is already up:

```sh
yarn install
yarn start        # backend on http://localhost:7100
```
