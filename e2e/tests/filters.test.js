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

// Field filters, which reach SWIRL as backstage_filters and become term
// queries on the Tantivy attrs field.

const { search, titles } = require('./support');

describe('field filters', () => {
  it('returns only documents matching kind=component and lifecycle=production', async () => {
    const result = await search({
      term: 'service',
      types: ['software-catalog'],
      filters: { kind: 'component', lifecycle: 'production' },
    });

    expect(result.results.length).toBeGreaterThan(0);
    for (const entry of result.results) {
      expect(entry.document.kind.toLowerCase()).toBe('component');
      expect(entry.document.lifecycle.toLowerCase()).toBe('production');
    }
  });

  it('drops a document the filter excludes but the term matches', async () => {
    // legacy-billing-service is planted as lifecycle: experimental precisely so
    // the filter has something to remove; without it the assertion above could
    // pass on a filter that does nothing.
    const unfiltered = await search({
      term: 'service',
      types: ['software-catalog'],
    });
    expect(titles(unfiltered)).toContain('legacy-billing-service');

    const filtered = await search({
      term: 'service',
      types: ['software-catalog'],
      filters: { kind: 'component', lifecycle: 'production' },
    });
    expect(titles(filtered)).not.toContain('legacy-billing-service');
  });
});
