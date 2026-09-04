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

export interface Config {
  search?: {
    /**
     * Configuration for the SWIRL search engine.
     *
     * @visibility backend
     */
    swirl?: {
      /** Base URL of the SWIRL for Backstage service, e.g. http://swirl:8000 */
      baseUrl: string;
      /** Backstage plugin id whose JWKS SWIRL trusts. Default "search". */
      audience?: string;
      /** Batch size for indexing. Default 500. */
      indexerBatchSize?: number;
      /** Request timeout in ms for query calls. Default 8000. */
      queryTimeoutMs?: number;
      /** Federated lane */
      federated?: {
        /** Register the swirl-federated document type. Default true. */
        enabled?: boolean;
        /** SWIRL provider tags to fan out to. Default ["backstage"]. */
        providerTags?: string[];
        /** Per-query federation timeout in ms passed to SWIRL. Default 5000. */
        timeoutMs?: number;
      };
      /**
       * Relevance tuning, mirrored to SWIRL on startup.
       *
       * These are the nested camelCase names, and they are the only shape
       * this schema accepts. SWIRL also takes its own flat snake_case names
       * (title_exact_boost, ngram_min, fuzzy_enabled and the rest) over the
       * same endpoint, but writing those here fails
       * `backstage-cli config:check --strict`, which is standard practice in
       * a Backstage repo. SWIRL folds the camelCase names onto its own, so
       * what you write here is what SWIRL applies; write camelCase.
       */
      tuning?: {
        fieldBoosts?: {
          titleExact?: number;
          titleNgram?: number;
          text?: number;
        };
        ngram?: { min?: number; max?: number };
        stemmer?: string;
        stopwords?: string[];
        fuzzy?: { enabled?: boolean; distance?: number };
        /**
         * Stored by SWIRL, not applied by the current engine version: the
         * Tantivy lane does not expose BM25 parameters, and SWIRL says so in
         * its answer to the startup tuning call, which the module logs as a
         * warning. Kept in the schema so that configs which already set it
         * keep validating; setting it has no effect on ranking.
         */
        bm25?: { k1?: number; b?: number };
      };
      highlight?: {
        enabled?: boolean;
        maxChars?: number;
        /**
         * The marker pair SWIRL wraps hits in, from its
         * SWIRL_HIGHLIGHT_START_CHAR and SWIRL_HIGHLIGHT_END_CHAR settings.
         * Defaults "<em>" and "</em>". Override both together if your SWIRL
         * is configured with a different pair.
         */
        startMarker?: string;
        endMarker?: string;
      };
    };
  };
}
