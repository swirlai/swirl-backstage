/*
 * Copyright 2026 SWIRL AI Connect
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Shared helpers for the end to end assertions. Everything here goes through
// the same public surfaces a Backstage user would: the guest auth endpoint and
// GET /api/search/query. Nothing reaches into the engine module directly.

const BACKSTAGE_URL = process.env.E2E_BACKSTAGE_URL ?? 'http://localhost:7100';
const SWIRL_URL = process.env.E2E_SWIRL_URL ?? 'http://localhost:8011';
const ADMIN_USER = process.env.SWIRL_E2E_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD =
  process.env.SWIRL_E2E_ADMIN_PASSWORD ?? 'swirl-e2e-local';

/**
 * A guest identity from the backend's own auth plugin.
 *
 * The response is `{ profile, backstageIdentity: { token, identity, ... } }`
 * and the bearer the search API wants is `backstageIdentity.token`. The shape
 * is asserted in permissions.test.js rather than assumed here.
 */
async function guestToken() {
  const response = await fetch(`${BACKSTAGE_URL}/api/auth/guest/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `POST /api/auth/guest/refresh returned HTTP ${response.status}`,
    );
  }
  const body = await response.json();
  const token = body?.backstageIdentity?.token;
  if (!token) {
    throw new Error(
      `no backstageIdentity.token in the guest refresh response: ${JSON.stringify(
        body,
      )}`,
    );
  }
  return token;
}

/**
 * GET /api/search/query. `types` and `filters` are optional; omitting `types`
 * is the case that matters for permissions, because that is where
 * AuthorizedSearchEngine substitutes the full registered type list.
 */
async function search({ term, types, filters, pageLimit } = {}) {
  const params = new URLSearchParams();
  params.set('term', term ?? '');
  for (const type of types ?? []) {
    params.append('types[]', type);
  }
  for (const [key, value] of Object.entries(filters ?? {})) {
    params.append(`filters[${key}]`, value);
  }
  if (pageLimit !== undefined) {
    params.set('pageLimit', String(pageLimit));
  }

  const token = await guestToken();
  const response = await fetch(
    `${BACKSTAGE_URL}/api/search/query?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      `GET /api/search/query?${params} returned HTTP ${
        response.status
      }: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

/** The titles of the top `n` results, in rank order. */
const titles = (result, n = result.results.length) =>
  result.results.slice(0, n).map(entry => entry.document.title ?? '');

/** The rank (1 based) of the first result with this exact title, or -1. */
const rankOf = (result, title) => {
  const index = result.results.findIndex(
    entry => entry.document.title === title,
  );
  return index === -1 ? -1 : index + 1;
};

/** GET /swirl/index/ through the SWIRL admin API. */
async function swirlIndex() {
  const response = await fetch(`${SWIRL_URL}/swirl/index/`, {
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${ADMIN_USER}:${ADMIN_PASSWORD}`,
      ).toString('base64')}`,
    },
  });
  if (!response.ok) {
    throw new Error(`GET /swirl/index/ returned HTTP ${response.status}`);
  }
  return response.json();
}

/** The live generation id for a document type, or null. */
async function liveGeneration(type) {
  const body = await swirlIndex();
  return body.types?.find(entry => entry.type === type)?.live ?? null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  BACKSTAGE_URL,
  SWIRL_URL,
  guestToken,
  liveGeneration,
  rankOf,
  search,
  sleep,
  swirlIndex,
  titles,
};
