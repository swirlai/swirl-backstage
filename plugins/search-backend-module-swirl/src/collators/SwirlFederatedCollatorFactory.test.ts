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

import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { TestPipeline } from '@backstage/plugin-search-backend-node';
import { SwirlFederatedCollatorFactory } from './SwirlFederatedCollatorFactory';

describe('SwirlFederatedCollatorFactory', () => {
  const logger = mockServices.logger.mock();

  const factory = SwirlFederatedCollatorFactory.fromConfig(
    new ConfigReader({ search: { swirl: { baseUrl: 'http://swirl:8000' } } }),
    { logger },
  );

  it('registers the swirl-federated document type', () => {
    expect(factory.type).toBe('swirl-federated');
  });

  it('yields zero documents', async () => {
    const collator = await factory.getCollator();

    const { documents, error } = await TestPipeline.fromCollator(
      collator,
    ).execute();

    expect(error).toBeFalsy();
    expect(documents).toHaveLength(0);
  });
});
