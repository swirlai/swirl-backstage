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

// The gate-zero cases from reboot-design/gauntlet-results.md, this time through
// the whole stack: Backstage's own search API, the search router, the SWIRL
// engine module, the SWIRL container, the Tantivy index. WP00 asserted these
// against Tantivy in process; these assert the same thing end to end.
//
// Every query narrows to types[]=software-catalog, so the federated lane stays
// out of the ranking. Federation has its own file.

const { rankOf, search, titles } = require('./support');

const CATALOG = ['software-catalog'];

const isTeamEntity = title => /team/i.test(title);

describe('gate zero, through GET /api/search/query', () => {
  it('ranks tech-radar above any team entity for "tech", with no team entity in the top 5', async () => {
    const result = await search({ term: 'tech', types: CATALOG });
    const top5 = titles(result, 5);

    expect(rankOf(result, 'tech-radar')).toBe(1);
    expect(top5.filter(isTeamEntity)).toEqual([]);

    const firstTeam = result.results.findIndex(entry =>
      isTeamEntity(entry.document.title ?? ''),
    );
    if (firstTeam !== -1) {
      expect(firstTeam + 1).toBeGreaterThan(rankOf(result, 'tech-radar'));
    }
  });

  it('finds abacus in the top 3 for the prefix "abac"', async () => {
    const result = await search({ term: 'abac', types: CATALOG });
    expect(titles(result, 3)).toContain('abacus');
  });

  it('puts foo-bar.com at rank 1 for "foo-bar.com"', async () => {
    const result = await search({ term: 'foo-bar.com', types: CATALOG });
    expect(rankOf(result, 'foo-bar.com')).toBe(1);
  });

  it('finds petstore in the top 3 for the infix "store"', async () => {
    const result = await search({ term: 'store', types: CATALOG });
    expect(titles(result, 3)).toContain('petstore');
  });

  it('returns nothing containing "web" or "used" in the top 5 for "mes"', async () => {
    const result = await search({ term: 'mes', types: CATALOG });
    for (const title of titles(result, 5)) {
      expect(title.toLowerCase()).not.toContain('web');
      expect(title.toLowerCase()).not.toContain('used');
    }
  });

  it('finds wayback-search in the top 3 for "wayback"', async () => {
    const result = await search({ term: 'wayback', types: CATALOG });
    expect(titles(result, 3)).toContain('wayback-search');
  });

  it('finds petstore in the top 3 for the typo "petsotre"', async () => {
    // Typo tolerance is SWIRL's fuzzy_fields, off by default and turned on by
    // search.swirl.tuning in the e2e app-config.
    const result = await search({ term: 'petsotre', types: CATALOG });
    expect(titles(result, 3)).toContain('petstore');
  });
});
