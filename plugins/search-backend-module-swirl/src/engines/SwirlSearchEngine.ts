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

import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  AuthService,
  BackstageCredentials,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import {
  QueryRequestOptions,
  SearchEngine,
} from '@backstage/plugin-search-backend-node';
import {
  IndexableResult,
  IndexableResultSet,
  SearchQuery,
} from '@backstage/plugin-search-common';
import { SwirlClient, SwirlRequestResult } from './SwirlClient';
import { SwirlIndexer } from './SwirlIndexer';
import { SwirlNoopIndexer } from './SwirlNoopIndexer';
import {
  MISSING_INDEX_ERROR_NAME,
  SWIRL_FEDERATED_TYPE,
  SWIRL_HIGHLIGHT_END_MARKER,
  SWIRL_HIGHLIGHT_START_MARKER,
  SWIRL_INDEX_PROVIDER_TAG,
  SwirlEngineConfig,
  SwirlPageCursor,
  SwirlResponse,
  SwirlResult,
  swirlResultScore,
} from './types';

/**
 * The SWIRL query the engine is about to run, after translation.
 *
 * @public
 */
export type ConcreteSwirlQuery = {
  term: string;
  /** Backstage document types read from the SWIRL index. */
  indexTypes?: string[];
  /** Whether the federated providers take part in this query. */
  federated: boolean;
  /** Field filters, forwarded to SWIRL as JSON. */
  filters: Record<string, unknown>;
  /** Results per page. */
  pageSize: number;
  /** Decoded page cursor, absent on page 0. */
  cursor?: SwirlPageCursor;
};

/**
 * Options handed to a SWIRL query translator.
 *
 * @public
 */
export type SwirlQueryTranslatorOptions = {
  federatedEnabled: boolean;
};

/**
 * SWIRL specific query translator.
 *
 * @public
 */
export type SwirlQueryTranslator = (
  query: SearchQuery,
  options: SwirlQueryTranslatorOptions,
) => ConcreteSwirlQuery;

/**
 * Options to instantiate {@link SwirlSearchEngine}.
 *
 * @public
 */
export type SwirlSearchEngineOptions = {
  logger: LoggerService;
  auth: AuthService;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * A Backstage search engine backed by SWIRL. Indexed Backstage documents are
 * served from the SWIRL index; results from connected sources arrive in the
 * same response under the `swirl-federated` type.
 *
 * @public
 */
export class SwirlSearchEngine implements SearchEngine {
  private readonly options: SwirlEngineConfig;
  private readonly logger: LoggerService;
  private readonly client: SwirlClient;
  private readonly preTag: string;
  private readonly postTag: string;

  private constructor(
    options: SwirlEngineConfig,
    deps: SwirlSearchEngineOptions,
  ) {
    this.options = options;
    this.logger = deps.logger;
    this.client = new SwirlClient({
      baseUrl: options.baseUrl,
      auth: deps.auth,
      audience: options.audience,
      timeoutMs: options.queryTimeoutMs,
      fetchImpl: deps.fetchImpl,
    });

    const tag = randomUUID();
    this.preTag = `<${tag}>`;
    this.postTag = `</${tag}>`;
  }

  static async fromConfig(
    config: Config,
    deps: SwirlSearchEngineOptions,
  ): Promise<SwirlSearchEngine> {
    const engine = new SwirlSearchEngine(readSwirlConfig(config), deps);
    await engine.pushTuning();
    return engine;
  }

  /**
   * Mirrors the app-config tuning block to SWIRL so that relevance is
   * configured in one place. A SWIRL that is not up yet, or an older SWIRL
   * that does not know the endpoint, must not stop the backend from booting.
   *
   * SWIRL answers with the effective tuning in its own flat form plus
   * `accepted_keys`, naming every key it took in the shape it was sent, and a
   * `bm25` notice when it stored BM25 parameters it cannot apply. Both are
   * logged, because a tuning block that is accepted by Backstage and then
   * quietly dropped by SWIRL is exactly the failure this call exists to make
   * visible. A 400 names the keys SWIRL did not recognise; that is a warning,
   * not a boot failure.
   */
  private async pushTuning(): Promise<void> {
    try {
      const token = await this.client.mintToken();
      const result = await this.client.request({
        url: this.client.url('/swirl/index/config/'),
        method: 'POST',
        token,
        body: this.options.tuning,
      });

      if (!result.ok) {
        const rejected = rejectedTuningKeys(result.body);
        const detail = rejected.length
          ? ` SWIRL did not recognise: ${rejected.join(', ')}.`
          : describeTuningError(result.body);
        this.logger.warn(
          `SWIRL rejected the relevance tuning block: HTTP ${result.status}.${detail} SWIRL keeps its current tuning.`,
        );
        return;
      }

      const body = (result.body ?? {}) as {
        accepted_keys?: unknown;
        bm25?: unknown;
      };
      const accepted = Array.isArray(body.accepted_keys)
        ? body.accepted_keys.map(String)
        : [];

      this.logger.info(
        accepted.length
          ? `Mirrored the relevance tuning block to SWIRL; SWIRL accepted: ${accepted.join(
              ', ',
            )}`
          : 'Mirrored the relevance tuning block to SWIRL; SWIRL reported no accepted tuning keys',
      );

      if (typeof body.bm25 === 'string' && body.bm25) {
        this.logger.warn(
          `SWIRL stored the bm25 tuning values but reports them "${body.bm25}", so search.swirl.tuning.bm25 has no effect on ranking.`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `Could not send the relevance tuning block to SWIRL at ${this.options.baseUrl}: ${e}. SWIRL keeps its current tuning.`,
      );
    }
  }

  translator(
    query: SearchQuery,
    options: SwirlQueryTranslatorOptions,
  ): ConcreteSwirlQuery {
    const pageSize = query.pageLimit || 25;
    const cursor = decodePageCursor(query.pageCursor);

    // The federated lane runs when the caller did not narrow by type, or
    // asked for the federated type by name. Under permissions the router
    // always passes the full list of registered types, which is why the
    // federated type has to be registered at all.
    const federated =
      options.federatedEnabled &&
      (query.types === undefined || query.types.includes(SWIRL_FEDERATED_TYPE));

    const indexTypes = query.types?.filter(
      type => type !== SWIRL_FEDERATED_TYPE,
    );

    return {
      term: query.term ?? '',
      indexTypes,
      federated,
      filters: (query.filters as Record<string, unknown>) ?? {},
      pageSize,
      cursor,
    };
  }

  setTranslator(translator: SwirlQueryTranslator) {
    this.translator = translator;
  }

  async getIndexer(type: string): Promise<Writable> {
    if (type === SWIRL_FEDERATED_TYPE) {
      return new SwirlNoopIndexer({ type, logger: this.logger });
    }

    return new SwirlIndexer({
      type,
      batchSize: this.options.indexerBatchSize,
      client: this.client,
      logger: this.logger,
    });
  }

  async query(
    query: SearchQuery,
    options?: QueryRequestOptions,
  ): Promise<IndexableResultSet> {
    const concrete = this.translator(query, {
      federatedEnabled: this.options.federated.enabled,
    });

    const token = await this.resolveToken(options);
    const result = concrete.cursor
      ? await this.fetchResultPage(concrete, concrete.cursor, token)
      : await this.fetchFirstPage(concrete, token);

    this.assertIndexPresent(result);

    if (!result.ok) {
      throw new Error(
        `SWIRL returned HTTP ${result.status} for the query ${JSON.stringify(
          concrete.term,
        )}`,
      );
    }

    const body = (result.body ?? {}) as SwirlResponse;
    const page = concrete.cursor?.p ?? 0;
    const searchId = concrete.cursor?.s ?? body.info?.search?.id;
    const swirlResults = body.results ?? [];

    const results = swirlResults.map((entry, index) =>
      this.toIndexableResult(entry, page * concrete.pageSize + index + 1),
    );

    const hasNextPage =
      searchId !== undefined && swirlResults.length >= concrete.pageSize;

    return {
      results,
      numberOfResults:
        body.info?.results?.found_total ??
        body.info?.results?.retrieved_total ??
        undefined,
      nextPageCursor: hasNextPage
        ? encodePageCursor({ s: searchId!, p: page + 1 })
        : undefined,
      previousPageCursor:
        page > 0 && searchId !== undefined
          ? encodePageCursor({ s: searchId, p: page - 1 })
          : undefined,
    };
  }

  /**
   * Page 0 federates: SWIRL runs the query across the Backstage index and,
   * when the federated lane is active, the connected providers too.
   */
  private async fetchFirstPage(
    concrete: ConcreteSwirlQuery,
    token: string,
  ): Promise<SwirlRequestResult> {
    const providers = [SWIRL_INDEX_PROVIDER_TAG];
    if (concrete.federated) {
      providers.push(...this.options.federated.providerTags);
    }

    return this.client.request({
      url: this.client.url('/swirl/search/', {
        qs: concrete.term,
        providers: providers.join(','),
        backstage_types: concrete.indexTypes?.join(',') ?? '',
        backstage_filters: JSON.stringify(concrete.filters),
        backstage_timeout_ms: concrete.federated
          ? this.options.federated.timeoutMs
          : undefined,
        results_requested: concrete.pageSize,
        rag: 'false',
      }),
      method: 'GET',
      token,
      timeoutMs: this.options.queryTimeoutMs,
    });
  }

  /**
   * Page N is a database read in SWIRL, not a second federation. That keeps
   * the paging loop in Backstage's AuthorizedSearchEngine cheap.
   */
  private async fetchResultPage(
    concrete: ConcreteSwirlQuery,
    cursor: SwirlPageCursor,
    token: string,
  ): Promise<SwirlRequestResult> {
    return this.client.request({
      url: this.client.url('/swirl/results/', {
        search_id: String(cursor.s),
        page: cursor.p + 1,
        results_requested: concrete.pageSize,
      }),
      method: 'GET',
      token,
      timeoutMs: this.options.queryTimeoutMs,
    });
  }

  /**
   * The search router hands the engine a plugin token minted per request,
   * carrying the caller's identity in its `obo` claim; that token is what
   * SWIRL verifies. Programmatic callers that reach the engine directly get
   * a freshly minted one instead.
   */
  private async resolveToken(options?: QueryRequestOptions): Promise<string> {
    if (options && 'token' in options && options.token) {
      return options.token;
    }

    const credentials =
      options && 'credentials' in options
        ? (options.credentials as BackstageCredentials)
        : undefined;

    return this.client.mintToken(credentials);
  }

  /**
   * SWIRL reports a type with no live index either as a 404 with an
   * `missing_index` error body, or as a structured `__MISSING_INDEX__` entry
   * in the response messages. Either way the caller asked for something that
   * has never been indexed, which is worth saying out loud rather than
   * returning an empty result set or a bare 500.
   */
  private assertIndexPresent(result: SwirlRequestResult): void {
    const body = result.body;

    if (result.status === 404 && body?.error === 'missing_index') {
      throw missingIndexError(body?.types);
    }

    for (const message of body?.messages ?? []) {
      if (
        typeof message !== 'string' ||
        !message.includes('__MISSING_INDEX__')
      ) {
        continue;
      }

      // SWIRL banner text and other free form strings share this array, so a
      // message that is not JSON is simply not one of ours.
      let parsed: any;
      try {
        parsed = JSON.parse(message);
      } catch {
        continue;
      }

      if (parsed?.type === '__MISSING_INDEX__') {
        throw missingIndexError(parsed.types);
      }
    }
  }

  private toIndexableResult(entry: SwirlResult, rank: number): IndexableResult {
    const backstage = entry.payload?.backstage;
    const indexed =
      backstage?.type !== undefined && backstage?.document !== undefined;

    return {
      type: indexed ? backstage!.type : SWIRL_FEDERATED_TYPE,
      document: indexed
        ? (backstage!.document as any)
        : {
            // Stripped defensively. SWIRL's relevancy processor writes the
            // marked up text back over `title` and `body`, which is what its
            // own UI renders; a Backstage renderer shows document text as
            // plain text, so the markers arrived on screen as literal
            // `<em>`. Current SWIRL keeps these fields clean, older ones do
            // not, and the engine has to be safe against both.
            title: this.stripMarkers(entry.title),
            text: this.stripMarkers(entry.body),
            location: entry.url ?? '',
            source: entry.searchprovider ?? '',
            // Federated results are not in any Backstage index, so SWIRL's
            // score is the only ranking signal a renderer can show. Indexed
            // documents are handed back exactly as Backstage collated them.
            score: swirlResultScore(entry),
          },
      rank,
      highlight: this.toHighlight(entry),
    };
  }

  private toHighlight(entry: SwirlResult) {
    if (!this.options.highlight.enabled) {
      return { preTag: this.preTag, postTag: this.postTag, fields: {} };
    }

    // Only the hit highlight lists. A marker sitting in the plain title or
    // body is not a hit - SWIRL keeps its hits in these two lists - and using
    // the plain field here would let a document forge its own highlight.
    const fields: Record<string, string> = {};
    const title = this.rewriteHighlight(entry.title_hit_highlights);
    const text = this.rewriteHighlight(entry.body_hit_highlights);

    if (title) {
      fields.title = title;
    }
    if (text) {
      fields.text = text;
    }

    return { preTag: this.preTag, postTag: this.postTag, fields };
  }

  /** Removes the configured marker pair, leaving the text it wrapped. */
  private stripMarkers(value: string | undefined): string {
    if (!value) {
      return '';
    }
    const { startMarker, endMarker } = this.options.highlight;
    return value.split(startMarker).join('').split(endMarker).join('');
  }

  /**
   * SWIRL wraps hits in a configurable marker pair, `<em>` and `</em>` out of
   * the box. Backstage expects the engine's own per-instance tags instead, so
   * that a document body containing the marker cannot forge a highlight.
   *
   * The `maxChars` budget counts visible characters, not tags, and the walk
   * never emits an unbalanced tag: a snippet cut short inside a hit closes it.
   */
  private rewriteHighlight(highlights?: string[]): string | undefined {
    const raw = (highlights ?? []).find(value => Boolean(value));
    if (!raw) {
      return undefined;
    }

    const { startMarker, endMarker, maxChars } = this.options.highlight;
    const pattern = new RegExp(
      `${escapeRegExp(startMarker)}([\\s\\S]*?)${escapeRegExp(endMarker)}`,
      'g',
    );

    let out = '';
    let budget = maxChars;
    let cursor = 0;

    const take = (value: string, hit: boolean) => {
      if (budget <= 0 || !value) {
        return;
      }
      const kept = value.slice(0, budget);
      budget -= kept.length;
      out += hit ? `${this.preTag}${kept}${this.postTag}` : kept;
    };

    for (const match of raw.matchAll(pattern)) {
      const at = match.index ?? 0;
      take(raw.slice(cursor, at), false);
      take(match[1], true);
      cursor = at + match[0].length;
    }
    take(raw.slice(cursor), false);

    return out;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The keys SWIRL named in a 400 from POST /swirl/index/config/. SWIRL answers
 * an unrecognised key with a detail line that starts
 * "unknown tuning key(s): a, b." rather than dropping it in silence.
 */
function rejectedTuningKeys(body: any): string[] {
  const detail = typeof body?.detail === 'string' ? body.detail : '';
  const match = detail.match(/unknown tuning key\(s\):\s*(.*)/i);
  if (!match) {
    return [];
  }
  // The detail continues "... Known keys are ...", and a nested key such as
  // fuzzy.bogus has a dot in it, so cut on that phrase rather than on a dot.
  return match[1]
    .split(/\.\s*Known keys/i)[0]
    .replace(/\.\s*$/, '')
    .split(',')
    .map((key: string) => key.trim())
    .filter(Boolean);
}

/** Whatever SWIRL said about a tuning block it would not take. */
function describeTuningError(body: any): string {
  const detail = typeof body?.detail === 'string' ? body.detail : '';
  return detail ? ` ${detail}` : '';
}

function missingIndexError(types?: unknown): Error {
  const named =
    Array.isArray(types) && types.length ? types.join(', ') : undefined;
  const error = new Error(
    named
      ? `SWIRL has no live index for the requested document type(s): ${named}. Wait for the collator to run, or check the SWIRL ingest logs.`
      : 'SWIRL has no live index for one of the requested document types. Wait for the collator to run, or check the SWIRL ingest logs.',
  );
  error.name = MISSING_INDEX_ERROR_NAME;
  return error;
}

/** @public */
export function decodePageCursor(
  pageCursor?: string,
): SwirlPageCursor | undefined {
  if (!pageCursor) {
    return undefined;
  }

  const decoded = JSON.parse(
    Buffer.from(pageCursor, 'base64').toString('utf-8'),
  );
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    decoded.s === undefined ||
    typeof decoded.p !== 'number' ||
    decoded.p < 0
  ) {
    throw new Error('Invalid page cursor');
  }

  return { s: decoded.s, p: decoded.p };
}

/** @public */
export function encodePageCursor(cursor: SwirlPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64');
}

/** @public */
export function readSwirlConfig(config: Config): SwirlEngineConfig {
  const swirl = config.getConfig('search.swirl');
  const federated = swirl.getOptionalConfig('federated');
  const highlight = swirl.getOptionalConfig('highlight');
  const tuning = swirl.getOptionalConfig('tuning');

  return {
    baseUrl: swirl.getString('baseUrl'),
    audience: swirl.getOptionalString('audience') ?? 'search',
    indexerBatchSize: swirl.getOptionalNumber('indexerBatchSize') ?? 500,
    queryTimeoutMs: swirl.getOptionalNumber('queryTimeoutMs') ?? 8000,
    federated: {
      enabled: federated?.getOptionalBoolean('enabled') ?? true,
      providerTags: federated?.getOptionalStringArray('providerTags') ?? [
        'backstage',
      ],
      timeoutMs: federated?.getOptionalNumber('timeoutMs') ?? 5000,
    },
    tuning: (tuning?.get() as SwirlEngineConfig['tuning']) ?? {},
    highlight: {
      enabled: highlight?.getOptionalBoolean('enabled') ?? true,
      maxChars: highlight?.getOptionalNumber('maxChars') ?? 200,
      startMarker:
        highlight?.getOptionalString('startMarker') ??
        SWIRL_HIGHLIGHT_START_MARKER,
      endMarker:
        highlight?.getOptionalString('endMarker') ?? SWIRL_HIGHLIGHT_END_MARKER,
    },
  };
}
