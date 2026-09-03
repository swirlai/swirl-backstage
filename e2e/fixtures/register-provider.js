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

// Registers the stub federated source as a SWIRL SearchProvider, through the
// admin REST API with Basic auth, the same way an operator would.
//
//   node e2e/fixtures/register-provider.js
//
// Idempotent: the provider is matched by name, so a second run updates it.
// The provider shape follows SearchProviders/hacker_news.json in the SWIRL
// repository: a RequestsGet connector, a query_template that appends the term,
// response_mappings that name the count and the result list, and
// result_mappings that name the title, body and url fields.

const SWIRL_URL = process.env.SWIRL_E2E_URL ?? 'http://localhost:8011';
const ADMIN_USER = process.env.SWIRL_E2E_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD =
  process.env.SWIRL_E2E_ADMIN_PASSWORD ?? 'swirl-e2e-local';
// The stub runs on the host; SWIRL runs in the container and reaches the host
// through host.docker.internal, which e2e/compose.yaml maps to host-gateway.
const STUB_PORT = Number(process.env.STUB_PROVIDER_PORT ?? 8012);
const STUB_URL =
  process.env.STUB_PROVIDER_URL ??
  `http://host.docker.internal:${STUB_PORT}/search`;

const PROVIDER_NAME = 'Stub - E2E';

const PROVIDER = {
  name: PROVIDER_NAME,
  shared: true,
  active: true,
  default: true,
  authenticator: '',
  connector: 'RequestsGet',
  url: STUB_URL,
  query_template: '{url}?q={query_string}',
  query_template_json: {},
  post_query_template: {},
  http_request_headers: {},
  page_fetch_config_json: {},
  query_processors: ['AdaptiveQueryProcessor'],
  query_mappings: '',
  result_grouping_field: '',
  result_processors: [
    'MappingResultProcessor',
    'CosineRelevancyResultProcessor',
  ],
  response_mappings: 'FOUND=count,RESULTS=results',
  result_mappings: 'title=title,body=body,url=url,NO_PAYLOAD',
  results_per_query: 10,
  credentials: '',
  eval_credentials: '',
  // The tag the engine module fans out to, from
  // search.swirl.federated.providerTags in the e2e app-config.
  tags: ['backstage'],
};

const authHeader = () =>
  `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64')}`;

async function call(method, path, body) {
  const response = await fetch(`${SWIRL_URL}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function itemsOf(body) {
  if (Array.isArray(body)) {
    return body;
  }
  // SWIRL paginates list responses; the shape depends on the page size.
  return body?.results ?? body?.items ?? [];
}

async function main() {
  const listed = await call('GET', '/swirl/searchproviders/?page_size=200');
  if (listed.status !== 200) {
    throw new Error(
      `listing SearchProviders returned HTTP ${listed.status}: ${JSON.stringify(
        listed.body,
      )}`,
    );
  }

  const existing = itemsOf(listed.body).find(
    provider => provider?.name === PROVIDER_NAME,
  );

  const result = existing
    ? await call('PUT', `/swirl/searchproviders/${existing.id}/`, PROVIDER)
    : await call('POST', '/swirl/searchproviders/', PROVIDER);

  if (result.status !== 200 && result.status !== 201) {
    throw new Error(
      `${existing ? 'updating' : 'creating'} the "${PROVIDER_NAME}" ` +
        `SearchProvider returned HTTP ${result.status}: ${JSON.stringify(
          result.body,
        )}`,
    );
  }

  const id = result.body?.id ?? existing?.id;
  // eslint-disable-next-line no-console
  console.log(
    `register-provider: ${existing ? 'updated' : 'created'} SearchProvider ` +
      `"${PROVIDER_NAME}" (id ${id}) pointing at ${STUB_URL}`,
  );
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error(`register-provider: ${error.message}`);
  process.exit(1);
});
