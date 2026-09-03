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
  SWIRL_INDEX_PROVIDER_TAG,
  SwirlEngineConfig,
  SwirlPageCursor,
  SwirlResponse,
  SwirlResult,
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
        this.logger.warn(
          `SWIRL rejected the relevance tuning block: HTTP ${result.status}. SWIRL keeps its current tuning.`,
        );
        return;
      }

      this.logger.info('Mirrored the relevance tuning block to SWIRL');
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
            title: entry.title ?? '',
            text: entry.body ?? '',
            location: entry.url ?? '',
            source: entry.searchprovider ?? '',
          },
      rank,
      highlight: this.toHighlight(entry),
    };
  }

  private toHighlight(entry: SwirlResult) {
    if (!this.options.highlight.enabled) {
      return { preTag: this.preTag, postTag: this.postTag, fields: {} };
    }

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

  /**
   * SWIRL marks hits with a start and end character, `*` by default. Backstage
   * expects the engine's own per-instance tags instead, so that a result body
   * containing the marker cannot forge a highlight.
   */
  private rewriteHighlight(highlights?: string[]): string | undefined {
    const raw = (highlights ?? []).find(value => Boolean(value));
    if (!raw) {
      return undefined;
    }

    let truncated = raw.slice(0, this.options.highlight.maxChars);
    if ((truncated.match(/\*/g) ?? []).length % 2 === 1) {
      truncated = truncated.slice(0, truncated.lastIndexOf('*'));
    }

    return truncated.replace(
      /\*([^*]+)\*/g,
      (_match, hit) => `${this.preTag}${hit}${this.postTag}`,
    );
  }
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
    },
  };
}
