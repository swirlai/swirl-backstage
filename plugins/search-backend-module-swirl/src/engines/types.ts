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

/**
 * The document type registered by the federated lane. Results that did not
 * come from the Backstage index are returned under this type.
 *
 * @public
 */
export const SWIRL_FEDERATED_TYPE = 'swirl-federated';

/**
 * The SWIRL SearchProvider tag that serves the Backstage index (the Tantivy
 * lane). Always included in the provider list sent to SWIRL.
 *
 * @public
 */
export const SWIRL_INDEX_PROVIDER_TAG = 'backstage-index';

/**
 * Name given to the error thrown when SWIRL reports that one of the requested
 * document types has no live index. The search router surfaces the name
 * instead of collapsing it into a generic 500.
 *
 * @public
 */
export const MISSING_INDEX_ERROR_NAME = 'MissingIndexError';

/**
 * Options resolved from `search.swirl` in app-config.
 *
 * @public
 */
export type SwirlEngineConfig = {
  baseUrl: string;
  audience: string;
  indexerBatchSize: number;
  queryTimeoutMs: number;
  federated: {
    enabled: boolean;
    providerTags: string[];
    timeoutMs: number;
  };
  tuning: SwirlTuning;
  highlight: {
    enabled: boolean;
    maxChars: number;
    startMarker: string;
    endMarker: string;
  };
};

/**
 * The marker pair SWIRL wraps hits in out of the box, from
 * `SWIRL_HIGHLIGHT_START_CHAR` and `SWIRL_HIGHLIGHT_END_CHAR`.
 *
 * @public
 */
export const SWIRL_HIGHLIGHT_START_MARKER = '<em>';

/**
 * @public
 */
export const SWIRL_HIGHLIGHT_END_MARKER = '</em>';

/**
 * The relevance tuning block mirrored to SWIRL on startup.
 *
 * @public
 */
export type SwirlTuning = {
  fieldBoosts?: { titleExact?: number; titleNgram?: number; text?: number };
  ngram?: { min?: number; max?: number };
  stemmer?: string;
  stopwords?: string[];
  fuzzy?: { enabled?: boolean; distance?: number };
  /** Stored by SWIRL, not applied by the current engine version. */
  bm25?: { k1?: number; b?: number };
};

/**
 * The `payload.backstage` block written by the SWIRL Tantivy connector for
 * documents that came from the Backstage index.
 *
 * @public
 */
export type SwirlBackstagePayload = {
  type: string;
  document: Record<string, any>;
};

/**
 * One entry of the `results` array in a SWIRL response envelope.
 *
 * @public
 */
export type SwirlResult = {
  title?: string;
  body?: string;
  url?: string;
  searchprovider?: string;
  swirl_rank?: number;
  swirl_score?: number;
  title_hit_highlights?: string[];
  body_hit_highlights?: string[];
  payload?: Record<string, any> & {
    backstage?: SwirlBackstagePayload;
    /**
     * The provider's own score. SWIRL's MappingResultProcessor sweeps keys it
     * does not recognise off the top level and into the payload, so the
     * Tantivy score arrives here rather than beside `swirl_score`.
     */
    searchprovider_score?: number;
  };
};

/**
 * Reads the score off a SWIRL result. The provider score lives in the payload
 * because SWIRL moves unrecognised top level keys there; `swirl_score`, which
 * the mixer sets, is the fallback.
 *
 * @public
 */
export function swirlResultScore(result: SwirlResult): number | undefined {
  return result.payload?.searchprovider_score ?? result.swirl_score;
}

/**
 * The SWIRL response envelope returned by `/swirl/search/` and
 * `/swirl/results/`.
 *
 * @public
 */
export type SwirlResponse = {
  messages?: string[];
  info?: {
    search?: { id?: number | string };
    results?: {
      found_total?: number;
      retrieved_total?: number;
      next_page?: string;
      prev_page?: string;
    };
    [provider: string]: any;
  };
  results?: SwirlResult[];
};

/**
 * The cursor the engine hands back to Backstage between pages. Encoded as
 * base64 JSON so that page N is a cheap `/swirl/results/` read rather than a
 * second federation.
 *
 * @public
 */
export type SwirlPageCursor = {
  /** SWIRL search id */
  s: number | string;
  /** zero based page number */
  p: number;
};
