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

import { LoggerService } from '@backstage/backend-plugin-api';
import { BatchSearchEngineIndexer } from '@backstage/plugin-search-backend-node';
import { IndexableDocument } from '@backstage/plugin-search-common';
import { SwirlClient, SwirlRequestResult } from './SwirlClient';

/**
 * Options for {@link SwirlIndexer}.
 *
 * @public
 */
export type SwirlIndexerOptions = {
  type: string;
  batchSize: number;
  client: SwirlClient;
  logger: LoggerService;
  /** Retries after the first attempt, on 5xx and transport errors. Default 3. */
  maxRetries?: number;
  /** First backoff step in ms; doubles per retry. Default 250. */
  retryBaseDelayMs?: number;
};

const sleep = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Writes one generation of documents of a single type into SWIRL, using the
 * generation lifecycle of the SWIRL ingest API: begin, docs, then finalize or
 * abort. The live generation is only replaced by a successful finalize, so a
 * stream that dies half way through leaves the served index untouched.
 *
 * @public
 */
export class SwirlIndexer extends BatchSearchEngineIndexer {
  private readonly type: string;
  private readonly client: SwirlClient;
  private readonly logger: LoggerService;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  private generation?: string;
  private numRecords = 0;
  private settled = false;

  constructor(options: SwirlIndexerOptions) {
    super({ batchSize: options.batchSize });
    this.type = options.type;
    this.client = options.client;
    this.logger = options.logger.child({ documentType: options.type });
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
  }

  async initialize(): Promise<void> {
    const token = await this.client.mintToken();
    const result = await this.client.request({
      url: this.client.url(
        `/swirl/index/${encodeURIComponent(this.type)}/begin/`,
      ),
      method: 'POST',
      token,
    });

    if (!result.ok) {
      throw new Error(
        `SWIRL refused to open a generation for ${this.type}: ${describe(
          result,
        )}`,
      );
    }

    const generation = result.body?.generation;
    if (generation === undefined || generation === null) {
      throw new Error(
        `SWIRL opened a generation for ${this.type} but returned no generation id`,
      );
    }

    this.generation = String(generation);
    this.logger.info(
      `Opened SWIRL index generation ${this.generation} for ${this.type}`,
    );
  }

  async index(documents: IndexableDocument[]): Promise<void> {
    const result = await this.postWithRetry(this.generationUrl('docs/'), {
      documents,
    });

    if (!result.ok) {
      throw new Error(
        `SWIRL rejected a batch of ${documents.length} ${
          this.type
        } documents: ${describe(result)}`,
      );
    }

    this.numRecords += documents.length;
  }

  async finalize(): Promise<void> {
    // Mirror the zero document guard the other engines apply: an empty
    // collator run must not wipe the index that is currently being served.
    if (this.numRecords === 0) {
      this.logger.warn(
        `Index for ${this.type} was not replaced: indexer received 0 documents`,
      );
      await this.abort();
      return;
    }

    const token = await this.client.mintToken();
    const result = await this.client.request({
      url: this.generationUrl('finalize/'),
      method: 'POST',
      token,
    });

    if (!result.ok) {
      throw new Error(
        `SWIRL failed to finalize generation ${this.generation} of ${
          this.type
        }: ${describe(result)}`,
      );
    }

    this.settled = true;

    this.logger.info(
      `Finalized SWIRL index generation ${this.generation} for ${this.type} with ${this.numRecords} documents`,
    );
  }

  /**
   * Covers the case where the failure happened elsewhere in the indexing
   * pipeline, in which case finalize is never called and the open generation
   * would otherwise block the next run. `BatchSearchEngineIndexer` has no
   * error hook, so this follows the approach the Postgres engine takes.
   *
   * @internal
   */
  async _destroy(error: Error | null, done: (error?: Error | null) => void) {
    if (!error) {
      done();
      return;
    }

    await this.abort();
    done(error);
  }

  /** Best effort: an abort that fails is logged, never rethrown. */
  private async abort(): Promise<void> {
    if (this.settled || !this.generation) {
      return;
    }
    this.settled = true;

    try {
      const token = await this.client.mintToken();
      await this.client.request({
        url: this.generationUrl('abort/'),
        method: 'POST',
        token,
      });
      this.logger.info(
        `Aborted SWIRL index generation ${this.generation} for ${this.type}`,
      );
    } catch (e) {
      this.logger.warn(
        `Could not abort SWIRL index generation ${this.generation} for ${this.type}: ${e}`,
      );
    }
  }

  private generationUrl(suffix: string): string {
    return this.client.url(
      `/swirl/index/${encodeURIComponent(this.type)}/${encodeURIComponent(
        this.generation!,
      )}/${suffix}`,
    );
  }

  private async postWithRetry(
    url: string,
    body: unknown,
  ): Promise<SwirlRequestResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }

      try {
        const token = await this.client.mintToken();
        const result = await this.client.request({
          url,
          method: 'POST',
          token,
          body,
        });

        if (result.status < 500) {
          return result;
        }

        lastError = new Error(describe(result));
        this.logger.warn(
          `SWIRL returned ${result.status} for ${this.type}, attempt ${
            attempt + 1
          } of ${this.maxRetries + 1}`,
        );
      } catch (e) {
        lastError = e;
        this.logger.warn(
          `SWIRL request for ${this.type} failed, attempt ${attempt + 1} of ${
            this.maxRetries + 1
          }: ${e}`,
        );
      }
    }

    throw new Error(
      `SWIRL request for ${this.type} failed after ${
        this.maxRetries + 1
      } attempts: ${lastError}`,
    );
  }
}

function describe(result: SwirlRequestResult): string {
  const detail =
    typeof result.body === 'string'
      ? result.body
      : JSON.stringify(result.body ?? {});
  return `HTTP ${result.status} ${detail}`;
}
