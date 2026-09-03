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

/**
 * Options for {@link SwirlNoopIndexer}.
 *
 * @public
 */
export type SwirlNoopIndexerOptions = {
  type: string;
  logger: LoggerService;
};

/**
 * The indexer handed back for the federated document type. The federated lane
 * has nothing to index: its collator yields zero documents and exists only so
 * the type is registered. Anything written here is dropped, so a stray
 * document can never reach the SWIRL ingest API under this type.
 *
 * @public
 */
export class SwirlNoopIndexer extends BatchSearchEngineIndexer {
  private readonly type: string;
  private readonly logger: LoggerService;
  private numRecords = 0;

  constructor(options: SwirlNoopIndexerOptions) {
    super({ batchSize: 100 });
    this.type = options.type;
    this.logger = options.logger.child({ documentType: options.type });
  }

  async initialize(): Promise<void> {}

  async index(documents: IndexableDocument[]): Promise<void> {
    this.numRecords += documents.length;
  }

  async finalize(): Promise<void> {
    if (this.numRecords > 0) {
      this.logger.warn(
        `Discarded ${this.numRecords} documents written to ${this.type}: the federated type is not indexed`,
      );
    }
  }
}
