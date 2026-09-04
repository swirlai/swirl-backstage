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

jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomUUID: jest.fn(() => 'tag-0000'),
}));

import {
  mockServices,
  registerMswTestHooks,
} from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { SwirlIndexer } from './SwirlIndexer';
import { SwirlNoopIndexer } from './SwirlNoopIndexer';
import {
  SwirlSearchEngine,
  decodePageCursor,
  encodePageCursor,
} from './SwirlSearchEngine';

const BASE_URL = 'http://swirl.test:8000';
const PRE = '<tag-0000>';
const POST = '</tag-0000>';

type Captured = { url: URL; authorization: string | null; body?: any };

describe('SwirlSearchEngine', () => {
  const worker = setupServer();
  registerMswTestHooks(worker);

  const logger = mockServices.logger.mock();
  const auth = mockServices.auth();

  let searchCalls: Captured[];
  let resultsCalls: Captured[];
  let configCalls: Captured[];

  const config = (swirl: Record<string, any> = {}) =>
    new ConfigReader({
      search: { swirl: { baseUrl: BASE_URL, ...swirl } },
    });

  const searchResponse = (overrides: Record<string, any> = {}) => ({
    messages: ['SWIRL 5.0'],
    info: {
      search: { id: 4711 },
      results: { found_total: 42, retrieved_total: 10 },
    },
    results: [],
    ...overrides,
  });

  const indexedResult = (title: string, entityRef: string) => ({
    title,
    body: `Body of ${title}`,
    url: `/catalog/default/component/${entityRef}`,
    searchprovider: 'Backstage Index',
    swirl_score: 0.5,
    title_hit_highlights: [`<em>${title}</em>`],
    body_hit_highlights: [`Body of <em>${title}</em>`],
    payload: {
      searchprovider_score: 7.25,
      backstage: {
        type: 'software-catalog',
        document: {
          title,
          text: `Body of ${title}`,
          location: `/catalog/default/component/${entityRef}`,
          componentType: 'service',
          authorization: { resourceRef: `component:default/${entityRef}` },
        },
      },
    },
  });

  const federatedResult = (title: string) => ({
    title,
    body: `Body of ${title}`,
    url: `https://github.example.com/${title}`,
    searchprovider: 'GitHub',
    swirl_score: 0.5,
    title_hit_highlights: [],
    body_hit_highlights: [],
    payload: { searchprovider_score: 3.5 },
  });

  const stubSwirl = (options?: {
    search?: () => any;
    results?: () => any;
    configEndpoint?: () => any;
  }) => {
    worker.use(
      http.post(`${BASE_URL}/swirl/index/config/`, async ({ request }) => {
        configCalls.push({
          url: new URL(request.url),
          authorization: request.headers.get('authorization'),
          body: await request.clone().json(),
        });
        return (
          options?.configEndpoint?.() ?? HttpResponse.json({ effective: {} })
        );
      }),
      http.get(`${BASE_URL}/swirl/search/`, ({ request }) => {
        searchCalls.push({
          url: new URL(request.url),
          authorization: request.headers.get('authorization'),
        });
        return options?.search?.() ?? HttpResponse.json(searchResponse());
      }),
      http.get(`${BASE_URL}/swirl/results/`, ({ request }) => {
        resultsCalls.push({
          url: new URL(request.url),
          authorization: request.headers.get('authorization'),
        });
        return options?.results?.() ?? HttpResponse.json(searchResponse());
      }),
    );
  };

  /**
   * Hands the engine an indexer for each type, the way the search backend
   * does at collation time, so that a query which names no types has
   * something to be measured against. The stream opens a generation on
   * construction and aborts it on end, so both endpoints are stubbed.
   */
  const seedIndexedTypes = async (
    engine: SwirlSearchEngine,
    types: string[],
  ) => {
    worker.use(
      http.post(`${BASE_URL}/swirl/index/:type/begin/`, () =>
        HttpResponse.json({ generation: 'gen-1' }, { status: 201 }),
      ),
      http.post(`${BASE_URL}/swirl/index/:type/:gen/abort/`, () =>
        HttpResponse.json(null, { status: 204 }),
      ),
    );

    for (const type of types) {
      const indexer = await engine.getIndexer(type);
      indexer.on('error', () => {});
      indexer.end();
      await new Promise(resolve => indexer.on('close', resolve));
    }
  };

  beforeEach(() => {
    searchCalls = [];
    resultsCalls = [];
    configCalls = [];
  });

  describe('startup', () => {
    it('mirrors the tuning block to SWIRL', async () => {
      stubSwirl();

      await SwirlSearchEngine.fromConfig(
        config({ tuning: { stemmer: 'en', bm25: { k1: 1.2, b: 0.75 } } }),
        { logger, auth },
      );

      expect(configCalls).toHaveLength(1);
      expect(configCalls[0].body).toEqual({
        stemmer: 'en',
        bm25: { k1: 1.2, b: 0.75 },
      });
      expect(configCalls[0].authorization).toMatch(/^Bearer .+/);
    });

    it('logs but does not throw when SWIRL is not reachable', async () => {
      worker.use(
        http.post(`${BASE_URL}/swirl/index/config/`, () =>
          HttpResponse.error(),
        ),
      );

      await expect(
        SwirlSearchEngine.fromConfig(config(), { logger, auth }),
      ).resolves.toBeInstanceOf(SwirlSearchEngine);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not send the relevance tuning block'),
      );
    });

    it('logs the keys SWIRL accepted', async () => {
      stubSwirl({
        configEndpoint: () =>
          HttpResponse.json({
            fuzzy_enabled: true,
            accepted_keys: ['fuzzy.enabled', 'fieldBoosts.titleExact'],
          }),
      });

      await SwirlSearchEngine.fromConfig(
        config({ tuning: { fuzzy: { enabled: true } } }),
        { logger, auth },
      );

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('fuzzy.enabled, fieldBoosts.titleExact'),
      );
    });

    it('says so when SWIRL reports no accepted tuning keys', async () => {
      stubSwirl({
        configEndpoint: () => HttpResponse.json({ accepted_keys: [] }),
      });

      await SwirlSearchEngine.fromConfig(config(), { logger, auth });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('no accepted tuning keys'),
      );
    });

    it('warns when SWIRL cannot apply the bm25 values', async () => {
      stubSwirl({
        configEndpoint: () =>
          HttpResponse.json({
            bm25_k1: 1.4,
            accepted_keys: ['bm25.k1', 'bm25.b'],
            bm25: 'not applied by this engine version',
          }),
      });

      await SwirlSearchEngine.fromConfig(
        config({ tuning: { bm25: { k1: 1.4, b: 0.5 } } }),
        { logger, auth },
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not applied by this engine version'),
      );
    });

    it('does not warn about bm25 when SWIRL says nothing about it', async () => {
      logger.warn.mockClear();
      stubSwirl({
        configEndpoint: () => HttpResponse.json({ accepted_keys: ['stemmer'] }),
      });

      await SwirlSearchEngine.fromConfig(
        config({ tuning: { stemmer: 'en' } }),
        {
          logger,
          auth,
        },
      );

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('bm25'),
      );
    });

    it('lists the tuning keys SWIRL rejected, and still boots', async () => {
      logger.warn.mockClear();
      worker.use(
        http.post(`${BASE_URL}/swirl/index/config/`, () =>
          HttpResponse.json(
            {
              // The wording SWIRL's config endpoint uses.
              detail:
                'unknown tuning key(s): nonsense, fuzzy.bogus. Known keys are ' +
                'the SWIRL names (bm25_b, bm25_k1, ...) and the nested ' +
                'Backstage names (bm25.b, bm25.k1, ...).',
            },
            { status: 400 },
          ),
        ),
      );

      await expect(
        SwirlSearchEngine.fromConfig(config({ tuning: { stemmer: 'en' } }), {
          logger,
          auth,
        }),
      ).resolves.toBeInstanceOf(SwirlSearchEngine);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'SWIRL did not recognise: nonsense, fuzzy.bogus',
        ),
      );
    });

    it('logs but does not throw when SWIRL rejects the tuning block', async () => {
      worker.use(
        http.post(`${BASE_URL}/swirl/index/config/`, () =>
          HttpResponse.json({ detail: 'nope' }, { status: 400 }),
        ),
      );

      await expect(
        SwirlSearchEngine.fromConfig(config(), { logger, auth }),
      ).resolves.toBeInstanceOf(SwirlSearchEngine);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SWIRL rejected the relevance tuning block'),
      );
    });
  });

  describe('getIndexer', () => {
    it('returns a real indexer for an indexed type and a no-op for the federated type', async () => {
      stubSwirl();
      worker.use(
        http.post(`${BASE_URL}/swirl/index/:type/begin/`, () =>
          HttpResponse.json({ generation: 'gen-1' }, { status: 201 }),
        ),
        http.post(`${BASE_URL}/swirl/index/:type/:gen/abort/`, () =>
          HttpResponse.json(null, { status: 204 }),
        ),
      );
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const indexed = await engine.getIndexer('software-catalog');
      const federated = await engine.getIndexer('swirl-federated');

      expect(indexed).toBeInstanceOf(SwirlIndexer);
      expect(federated).toBeInstanceOf(SwirlNoopIndexer);

      // These are live streams. Close them so they cannot outlive the test.
      for (const indexer of [indexed, federated]) {
        indexer.on('error', () => {});
        indexer.end();
        await new Promise(resolve => indexer.on('close', resolve));
      }
    });
  });

  describe('query', () => {
    const newEngine = (swirl: Record<string, any> = {}) => {
      stubSwirl();
      return SwirlSearchEngine.fromConfig(config(swirl), { logger, auth });
    };

    it('federates on page 0 and forwards the router token unchanged', async () => {
      const engine = await newEngine();

      await engine.query(
        {
          term: 'tech docs',
          types: ['software-catalog', 'swirl-federated'],
          filters: { kind: 'Component' },
        },
        { token: 'router-minted-token' },
      );

      expect(resultsCalls).toHaveLength(0);
      expect(searchCalls).toHaveLength(1);

      const params = searchCalls[0].url.searchParams;
      expect(params.get('qs')).toBe('tech docs');
      expect(params.get('providers')).toBe('backstage-index,backstage');
      expect(params.get('backstage_types')).toBe('software-catalog');
      expect(params.get('backstage_filters')).toBe('{"kind":"Component"}');
      expect(params.get('rag')).toBe('false');
      expect(searchCalls[0].authorization).toBe('Bearer router-minted-token');
    });

    it('mints its own token when the caller supplied none', async () => {
      const engine = await newEngine();

      await engine.query({ term: 'tech' });

      expect(searchCalls[0].authorization).toMatch(/^Bearer .+/);
      expect(searchCalls[0].authorization).not.toBe(
        'Bearer router-minted-token',
      );
    });

    it('reads page N from the results endpoint rather than federating again', async () => {
      const engine = await newEngine();

      await engine.query(
        {
          term: 'tech',
          pageCursor: encodePageCursor({ s: 4711, p: 1 }),
        },
        { token: 'router-minted-token' },
      );

      expect(searchCalls).toHaveLength(0);
      expect(resultsCalls).toHaveLength(1);
      expect(resultsCalls[0].url.searchParams.get('search_id')).toBe('4711');
      // SWIRL pages are one based, Backstage cursors are zero based.
      expect(resultsCalls[0].url.searchParams.get('page')).toBe('2');
      expect(resultsCalls[0].authorization).toBe('Bearer router-minted-token');
    });

    it('leaves the federated providers out when only indexed types were asked for', async () => {
      const engine = await newEngine();

      await engine.query({ term: 'tech', types: ['software-catalog'] });

      expect(searchCalls[0].url.searchParams.get('providers')).toBe(
        'backstage-index',
      );
    });

    it('includes the federated providers when no types were asked for', async () => {
      const engine = await newEngine();

      await engine.query({ term: 'tech' });

      expect(searchCalls[0].url.searchParams.get('providers')).toBe(
        'backstage-index,backstage',
      );
      expect(searchCalls[0].url.searchParams.get('backstage_types')).toBeNull();
    });

    it('never federates when the federated lane is switched off', async () => {
      const engine = await newEngine({
        federated: { enabled: false, providerTags: ['github', 'confluence'] },
      });

      await engine.query({ term: 'tech', types: ['swirl-federated'] });

      expect(searchCalls[0].url.searchParams.get('providers')).toBe(
        'backstage-index',
      );
    });

    it('uses the configured provider tags', async () => {
      const engine = await newEngine({
        federated: { providerTags: ['github', 'confluence'] },
      });

      await engine.query({ term: 'tech' });

      expect(searchCalls[0].url.searchParams.get('providers')).toBe(
        'backstage-index,github,confluence',
      );
    });

    it('maps indexed results back to their Backstage type and document', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              results: [indexedResult('Petstore', 'petstore')],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const { results, numberOfResults } = await engine.query({ term: 'pet' });

      expect(numberOfResults).toBe(42);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('software-catalog');
      expect(results[0].rank).toBe(1);
      expect(results[0].document).toEqual({
        title: 'Petstore',
        text: 'Body of Petstore',
        location: '/catalog/default/component/petstore',
        componentType: 'service',
        authorization: { resourceRef: 'component:default/petstore' },
      });
    });

    it('maps results with no Backstage payload to the federated type', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({ results: [federatedResult('Runbook')] }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const { results } = await engine.query({ term: 'runbook' });

      expect(results[0].type).toBe('swirl-federated');
      expect(results[0].document).toEqual({
        title: 'Runbook',
        text: 'Body of Runbook',
        location: 'https://github.example.com/Runbook',
        source: 'GitHub',
        score: 3.5,
      });
    });

    it('strips SWIRL highlight markers out of a federated document', async () => {
      // Defensive: current SWIRL keeps title and body clean on the Backstage
      // path, older ones write the marked up text back over them and a
      // Backstage renderer shows document text as plain text, so the markers
      // reached the screen as literal <em>.
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              results: [
                {
                  ...federatedResult('Runbook'),
                  title: 'The <em>Runbook</em> service',
                  body: 'A <em>runbook</em> for demonstrations.',
                  title_hit_highlights: ['The <em>Runbook</em> service'],
                  body_hit_highlights: [
                    'A <em>runbook</em> for demonstrations.',
                  ],
                },
              ],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const { results } = await engine.query({ term: 'runbook' });

      expect(results[0].document).toEqual({
        title: 'The Runbook service',
        text: 'A runbook for demonstrations.',
        location: 'https://github.example.com/Runbook',
        source: 'GitHub',
        score: 3.5,
      });
      // The marked up text is not lost, it is in the highlight fields with
      // this instance's own tags.
      expect(results[0].highlight!.fields).toEqual({
        title: `The ${PRE}Runbook${POST} service`,
        text: `A ${PRE}runbook${POST} for demonstrations.`,
      });
    });

    it('strips a custom marker pair out of a federated document', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              results: [
                {
                  ...federatedResult('Runbook'),
                  title: 'The [[Runbook]] service',
                  body: 'A [[runbook]] for demonstrations.',
                },
              ],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(
        config({ highlight: { startMarker: '[[', endMarker: ']]' } }),
        { logger, auth },
      );

      const { results } = await engine.query({ term: 'runbook' });

      expect(results[0].document).toMatchObject({
        title: 'The Runbook service',
        text: 'A runbook for demonstrations.',
      });
    });

    it('gives a federated result the highlight fields SWIRL now sends', async () => {
      // The e2e run observed these two lists empty for federated results, so
      // highlight.fields came back empty while the markers sat in the plain
      // fields. SWIRL fills them now; this is the shape the engine maps.
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              results: [
                {
                  ...federatedResult('Runbook'),
                  title_hit_highlights: ['The <em>Runbook</em>'],
                  body_hit_highlights: ['Body of <em>Runbook</em>'],
                },
              ],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const { results } = await engine.query({ term: 'runbook' });

      expect(results[0].type).toBe('swirl-federated');
      expect(results[0].highlight).toEqual({
        preTag: PRE,
        postTag: POST,
        fields: {
          title: `The ${PRE}Runbook${POST}`,
          text: `Body of ${PRE}Runbook${POST}`,
        },
      });
    });

    it('reads the score out of the payload, where SWIRL sweeps it', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              results: [
                federatedResult('With payload score'),
                {
                  ...federatedResult('Without payload score'),
                  payload: {},
                },
              ],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const { results } = await engine.query({ term: 'runbook' });

      // payload.searchprovider_score wins; swirl_score is the fallback.
      expect((results[0].document as any).score).toBe(3.5);
      expect((results[1].document as any).score).toBe(0.5);
      // Rank stays the order SWIRL's mixer returned, not a re-sort by score.
      expect(results.map(result => result.rank)).toEqual([1, 2]);
    });

    it('rewrites SWIRL <em> hit markers to its own per instance tags', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              results: [indexedResult('Petstore', 'petstore')],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const { results } = await engine.query({ term: 'petstore' });

      expect(results[0].highlight).toEqual({
        preTag: PRE,
        postTag: POST,
        fields: {
          title: `${PRE}Petstore${POST}`,
          text: `Body of ${PRE}Petstore${POST}`,
        },
      });
    });

    it('drops highlights when they are switched off', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              results: [indexedResult('Petstore', 'petstore')],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(
        config({ highlight: { enabled: false } }),
        { logger, auth },
      );

      const { results } = await engine.query({ term: 'petstore' });

      expect(results[0].highlight).toEqual({
        preTag: PRE,
        postTag: POST,
        fields: {},
      });
    });

    it('honours a SWIRL configured with a different marker pair', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              results: [
                {
                  ...federatedResult('Runbook'),
                  title_hit_highlights: ['[[Runbook]] notes'],
                },
              ],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(
        config({ highlight: { startMarker: '[[', endMarker: ']]' } }),
        { logger, auth },
      );

      const { results } = await engine.query({ term: 'runbook' });

      expect(results[0].highlight!.fields.title).toBe(
        `${PRE}Runbook${POST} notes`,
      );
    });

    it('budgets maxChars against visible text and never leaves a tag open', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              results: [
                {
                  ...federatedResult('Runbook'),
                  body_hit_highlights: ['abcd <em>efghij</em> klmn'],
                },
              ],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(
        config({ highlight: { maxChars: 8 } }),
        { logger, auth },
      );

      const { results } = await engine.query({ term: 'runbook' });

      // Eight visible characters: "abcd " plus the first three of the hit,
      // with the hit closed even though it was cut short.
      expect(results[0].highlight!.fields.text).toBe(`abcd ${PRE}efg${POST}`);
    });

    it('leaves a marker in the document body alone', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              results: [
                {
                  ...federatedResult('Runbook'),
                  body_hit_highlights: [],
                  body: 'not a hit: <em>forged</em>',
                },
              ],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const { results } = await engine.query({ term: 'runbook' });

      expect(results[0].highlight!.fields.text).toBeUndefined();
      expect(results[0].highlight).toEqual({
        preTag: PRE,
        postTag: POST,
        fields: {},
      });
    });

    it('round trips the page cursor and ranks results across pages', async () => {
      const page = (count: number) =>
        HttpResponse.json(
          searchResponse({
            results: Array.from({ length: count }, (_, index) =>
              indexedResult(`Component ${index}`, `component-${index}`),
            ),
          }),
        );

      stubSwirl({ search: () => page(2), results: () => page(2) });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const first = await engine.query({ term: 'tech', pageLimit: 2 });

      expect(first.previousPageCursor).toBeUndefined();
      expect(decodePageCursor(first.nextPageCursor)).toEqual({ s: 4711, p: 1 });

      const second = await engine.query({
        term: 'tech',
        pageLimit: 2,
        pageCursor: first.nextPageCursor,
      });

      expect(decodePageCursor(second.previousPageCursor)).toEqual({
        s: 4711,
        p: 0,
      });
      expect(second.results.map(result => result.rank)).toEqual([3, 4]);
    });

    it('offers no next page when the page was not full', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({ results: [indexedResult('One', 'one')] }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const { nextPageCursor } = await engine.query({
        term: 'tech',
        pageLimit: 25,
      });

      expect(nextPageCursor).toBeUndefined();
    });

    it('rejects a malformed page cursor', async () => {
      const engine = await newEngine();

      await expect(
        engine.query({
          term: 'tech',
          pageCursor: Buffer.from('{"p":-1}', 'utf-8').toString('base64'),
        }),
      ).rejects.toThrow('Invalid page cursor');
    });

    it('throws MissingIndexError when SWIRL answers 404 for a type', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            { error: 'missing_index', types: ['techdocs'] },
            { status: 404 },
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      await expect(
        engine.query({ term: 'tech', types: ['techdocs'] }),
      ).rejects.toMatchObject({
        name: 'MissingIndexError',
        message: expect.stringContaining('techdocs'),
      });
    });

    it('throws MissingIndexError on a structured message in a 200 response', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              messages: [
                'SWIRL 5.0',
                JSON.stringify({
                  type: '__MISSING_INDEX__',
                  types: ['techdocs'],
                }),
              ],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      await expect(
        engine.query({ term: 'tech', types: ['techdocs'] }),
      ).rejects.toMatchObject({ name: 'MissingIndexError' });
    });

    it('throws MissingIndexError when the 404 names no types at all', async () => {
      // Nothing to measure the report against, so the loud answer stands.
      stubSwirl({
        search: () =>
          HttpResponse.json({ error: 'missing_index' }, { status: 404 }),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      await expect(
        engine.query({ term: 'tech', types: ['software-catalog', 'techdocs'] }),
      ).rejects.toMatchObject({ name: 'MissingIndexError' });
    });

    it('returns an empty page when a 404 names only some of the requested types', async () => {
      // The everyday case: TechDocs is legitimately empty on a portal with no
      // mkdocs content, and under permissions the router puts it on every
      // query. A term that matched nothing must not become an error.
      stubSwirl({
        search: () =>
          HttpResponse.json(
            { error: 'missing_index', types: ['techdocs'] },
            { status: 404 },
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const result = await engine.query({
        term: 'petstore',
        types: ['software-catalog', 'techdocs'],
      });

      expect(result.results).toEqual([]);
      expect(result.numberOfResults).toBe(0);
      expect(result.nextPageCursor).toBeUndefined();
      expect(result.previousPageCursor).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('no live index for techdocs'),
      );
    });

    it('measures a 404 against every type it has indexed when the query named none', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            { error: 'missing_index', types: ['techdocs'] },
            { status: 404 },
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });
      await seedIndexedTypes(engine, ['software-catalog', 'techdocs']);

      const result = await engine.query({ term: 'petstore' });

      expect(result.results).toEqual([]);
      expect(result.numberOfResults).toBe(0);
    });

    it('throws when every type it has indexed is missing and the query named none', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            { error: 'missing_index', types: ['software-catalog', 'techdocs'] },
            { status: 404 },
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });
      await seedIndexedTypes(engine, ['software-catalog', 'techdocs']);

      await expect(engine.query({ term: 'petstore' })).rejects.toMatchObject({
        name: 'MissingIndexError',
        message: expect.stringContaining('software-catalog, techdocs'),
      });
    });

    it('returns an empty page for a soft missing index message with no results', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              messages: [
                'SWIRL 5.0',
                JSON.stringify({
                  type: '__MISSING_INDEX__',
                  types: ['techdocs'],
                }),
              ],
              results: [],
              info: {
                search: { id: 4711 },
                results: { found_total: 0, retrieved_total: 0 },
              },
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const result = await engine.query({
        term: 'petstore',
        types: ['software-catalog', 'techdocs'],
      });

      expect(result.results).toEqual([]);
      expect(result.numberOfResults).toBe(0);
      expect(result.nextPageCursor).toBeUndefined();
    });

    it('keeps the results that came with a soft missing index message', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json(
            searchResponse({
              messages: [
                'SWIRL 5.0',
                JSON.stringify({
                  type: '__MISSING_INDEX__',
                  types: ['techdocs'],
                }),
              ],
              results: [indexedResult('One', 'one')],
            }),
          ),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const result = await engine.query({
        term: 'one',
        types: ['software-catalog', 'techdocs'],
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].document.title).toBe('One');
    });

    it('throws a plain error on any other SWIRL failure', async () => {
      stubSwirl({
        search: () =>
          HttpResponse.json({ detail: 'exploded' }, { status: 500 }),
      });
      const engine = await SwirlSearchEngine.fromConfig(config(), {
        logger,
        auth,
      });

      const error = await engine.query({ term: 'tech' }).catch(e => e);

      expect(error.name).toBe('Error');
      expect(error.message).toMatch(/HTTP 500/);
    });

    it('honours a translator set by an extension point', async () => {
      const engine = await newEngine();
      engine.setTranslator(() => ({
        term: 'rewritten',
        indexTypes: ['techdocs'],
        federated: false,
        filters: {},
        pageSize: 25,
        cursor: undefined,
      }));

      await engine.query({ term: 'original' });

      expect(searchCalls[0].url.searchParams.get('qs')).toBe('rewritten');
      expect(searchCalls[0].url.searchParams.get('backstage_types')).toBe(
        'techdocs',
      );
      expect(searchCalls[0].url.searchParams.get('providers')).toBe(
        'backstage-index',
      );
    });
  });
});
