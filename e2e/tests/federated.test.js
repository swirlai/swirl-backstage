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

// The federated lane. The stub source in e2e/fixtures/stub-provider is
// registered in SWIRL as a RequestsGet SearchProvider tagged "backstage", the
// tag the engine module fans out to. Backstage never talks to it; a result from
// it can only have arrived through SWIRL.

const { search } = require('./support');

const STUB_HOST = 'http://stub.e2e.invalid/';

describe('the swirl-federated lane', () => {
  it('returns a swirl-federated result located at the stub source', async () => {
    const result = await search({ term: 'stub' });

    const federated = result.results.filter(
      entry => entry.type === 'swirl-federated',
    );
    expect(federated.length).toBeGreaterThanOrEqual(1);

    for (const entry of federated) {
      expect(entry.document.location.startsWith(STUB_HOST)).toBe(true);
    }

    // The stub is the only thing in the run that knows this host, so the
    // location is proof the result did not come out of the Backstage catalog.
    expect(
      federated.some(entry => entry.document.location.startsWith(STUB_HOST)),
    ).toBe(true);
  });

  it('leaves the federated lane out when the caller asks only for software-catalog', async () => {
    const result = await search({ term: 'stub', types: ['software-catalog'] });

    expect(
      result.results.filter(entry => entry.type === 'swirl-federated'),
    ).toEqual([]);
    for (const entry of result.results) {
      expect(entry.type).toBe('software-catalog');
    }
  });
});
