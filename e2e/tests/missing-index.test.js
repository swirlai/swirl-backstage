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

// B2 from the post-publish smoke test: a search that matched nothing came back
// as HTTP 500.
//
// The mechanism is ordinary rather than exotic. This app registers the techdocs
// collator but has no mkdocs content, so the techdocs generation aborts on zero
// documents - the guard working as designed - and techdocs has no live index.
// Under `permission.enabled` the search router puts every registered type on
// every query, so techdocs is always in the type list. A query that also
// matched nothing then had SWIRL answering "no live index for techdocs" with
// no results to soften it, and the engine turned that into an error.
//
// A type that is legitimately and permanently empty must not turn a search that
// matched nothing into an error. A query where *nothing* asked for is indexed
// still must.

const { BACKSTAGE_URL, guestToken, liveGeneration } = require('./support');

/** GET /api/search/query without throwing on a non-2xx, which is the point. */
async function rawSearch({ term, types }) {
  const params = new URLSearchParams();
  params.set('term', term);
  for (const type of types ?? []) {
    params.append('types[]', type);
  }

  const token = await guestToken();
  const response = await fetch(
    `${BACKSTAGE_URL}/api/search/query?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return { status: response.status, body: await response.json() };
}

// Matches nothing in the catalog, in the stub federated source, or anywhere
// else. Deliberately not a word.
const NO_MATCH = 'zzqqxwolfram';

// The two indexed types this app registers. Naming them keeps the federated
// lane out, which is what makes the query genuinely zero-hit: the stub
// federated source answers every term, so an untyped query is never empty here
// and would not reproduce B2 at all.
const BOTH = ['software-catalog', 'techdocs'];

describe('a type with no live index', () => {
  it('is the state this app is actually in: techdocs has no live generation', async () => {
    expect(await liveGeneration('techdocs')).toBeNull();
    expect(await liveGeneration('software-catalog')).not.toBeNull();
  });

  it('returns 200 and an empty page for a zero-hit query that names both types', async () => {
    const { status, body } = await rawSearch({ term: NO_MATCH, types: BOTH });

    expect(status).toBe(200);
    expect(body.results).toEqual([]);
    expect(body.numberOfResults).toBe(0);
  });

  it('returns 200 and hits when the term matches and techdocs is missing', async () => {
    // The path that already worked: SWIRL reports the missing type as a soft
    // message beside the results rather than as a 404. Asserted here so the
    // two halves of the same condition stay together.
    const { status, body } = await rawSearch({
      term: 'petstore',
      types: BOTH,
    });

    expect(status).toBe(200);
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('still reports MissingIndexError when the only type asked for is missing', async () => {
    // The loud answer is right here: nothing the caller asked for is indexed,
    // so an empty page would hide the cause.
    const { status, body } = await rawSearch({
      term: NO_MATCH,
      types: ['techdocs'],
    });

    expect(status).toBe(500);
    expect(body.error?.name).toBe('MissingIndexError');
    expect(body.error?.message).toContain('techdocs');
  });
});
