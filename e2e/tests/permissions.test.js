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

// What this file does and does not prove.
//
// It proves that the query runs through AuthorizedSearchEngine, which is the
// wrapper the search plugin installs when permission.enabled is true, and that
// the SWIRL engine survives the two things that wrapper does to it: it passes
// the full list of registered document types explicitly even when the caller
// named none, and it pages through the engine.
//
// It does NOT prove that two different users see different results. create-app
// ships one guest identity and no way to mint a second, and the create-app
// permission policy allows everything, so there is no per-user filtering to
// observe. Per-user result filtering is untested here; it needs a backend with
// a real identity provider and a policy that returns a conditional decision.

const fs = require('node:fs');
const { search, sleep, BACKSTAGE_URL } = require('./support');

const BACKEND_LOG = process.env.E2E_BACKEND_LOG;

/** Lines of the backend log after the last mention of `marker`. */
function logLinesAfter(marker) {
  const lines = fs.readFileSync(BACKEND_LOG, 'utf-8').split('\n');
  const at = lines.findLastIndex(line => line.includes(marker));
  return at === -1 ? [] : lines.slice(at);
}

describe('the permission path', () => {
  it('mints a guest identity whose bearer is backstageIdentity.token', async () => {
    const response = await fetch(`${BACKSTAGE_URL}/api/auth/guest/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(typeof body.backstageIdentity.token).toBe('string');
    // Three dot separated segments: it is a JWT, not an opaque handle.
    expect(body.backstageIdentity.token.split('.')).toHaveLength(3);
    expect(body.backstageIdentity.identity.userEntityRef).toMatch(
      /^user:.+\/.+$/,
    );
  });

  it('runs the query through AuthorizedSearchEngine when permission.enabled is true', async () => {
    expect(BACKEND_LOG).toBeTruthy();

    // A term nothing else in the run uses, so the log lines are unambiguous.
    const term = `permissionprobe${Date.now()}`;
    await search({ term });
    await sleep(1000);

    const after = logLinesAfter(`Search request received: term="${term}"`);
    expect(after.length).toBeGreaterThan(0);

    // AuthorizedSearchEngine is the only thing in the search plugin that calls
    // the permission backend. With permission.enabled false the router hands
    // the query straight to the engine and this line never appears.
    const authorize = after.filter(line =>
      line.includes('POST /api/permission/authorize'),
    );
    expect(authorize.length).toBeGreaterThan(0);
  });

  it('keeps the swirl-federated type reachable through the wrapper', async () => {
    // The caller names no types, so AuthorizedSearchEngine substitutes the full
    // registered list. A federated result coming back means swirl-federated was
    // in that list, which is the whole reason the module registers a collator
    // that yields nothing.
    const result = await search({ term: 'stub' });
    const types = new Set(result.results.map(entry => entry.type));
    expect(types.has('swirl-federated')).toBe(true);
  });
});
