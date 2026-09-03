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

import { Readable } from 'node:stream';
import { LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import {
  DocumentCollatorFactory,
  IndexableDocument,
} from '@backstage/plugin-search-common';
import { SWIRL_FEDERATED_TYPE } from '../engines/types';

/**
 * Options for {@link SwirlFederatedCollatorFactory}.
 *
 * @public
 */
export type SwirlFederatedCollatorFactoryOptions = {
  logger: LoggerService;
};

/**
 * A collator that yields no documents.
 *
 * Federated results are produced by SWIRL at query time and are never indexed
 * by Backstage, but they still need a registered document type: the type is
 * what makes them appear in `getDocumentTypes()`, survive
 * `AuthorizedSearchEngine` when permissions are on, and show up as a filter in
 * the search UI. Registering an empty collator is the cheapest way to declare
 * the type.
 *
 * @public
 */
export class SwirlFederatedCollatorFactory implements DocumentCollatorFactory {
  readonly type = SWIRL_FEDERATED_TYPE;

  private readonly logger: LoggerService;

  private constructor(options: SwirlFederatedCollatorFactoryOptions) {
    this.logger = options.logger;
  }

  static fromConfig(
    _config: Config,
    options: SwirlFederatedCollatorFactoryOptions,
  ): SwirlFederatedCollatorFactory {
    return new SwirlFederatedCollatorFactory(options);
  }

  async getCollator(): Promise<Readable> {
    return Readable.from(this.execute());
  }

  private async *execute(): AsyncGenerator<IndexableDocument> {
    this.logger.debug(
      `The ${SWIRL_FEDERATED_TYPE} type is served at query time by SWIRL; nothing to index`,
    );
  }
}
