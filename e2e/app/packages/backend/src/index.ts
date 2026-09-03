/*
 * The e2e Backstage backend (WP09).
 *
 * A create-app backend trimmed to what the end to end assertions need: auth
 * (guest), catalog, permissions with the allow-all policy, techdocs, and the
 * search plugin with the catalog and techdocs collators. The SWIRL engine
 * module replaces the create-app default search engine; nothing else about the
 * search wiring changes, which is the point of the test.
 */

import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));

// techdocs plugin, for the techdocs collator below
backend.add(import('@backstage/plugin-techdocs-backend'));

// permission plugin, with the create-app allow-all policy
backend.add(import('@backstage/plugin-permission-backend'));
backend.add(
  import('@backstage/plugin-permission-backend-module-allow-all-policy'),
);

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engine: SWIRL instead of the create-app default
backend.add(
  import('@swirl-search/backstage-plugin-search-backend-module-swirl'),
);

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

backend.start();
