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

import {
  mockServices,
  registerMswTestHooks,
  startTestBackend,
} from '@backstage/backend-test-utils';
import {
  searchEngineRegistryExtensionPoint,
  searchIndexRegistryExtensionPoint,
} from '@backstage/plugin-search-backend-node/alpha';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { SwirlSearchEngine } from './engines/SwirlSearchEngine';
import { searchModuleSwirlEngine } from './module';

const BASE_URL = 'http://swirl.test:8000';

describe('searchModuleSwirlEngine', () => {
  const worker = setupServer();
  registerMswTestHooks(worker);

  const engineExtensionPoint = { setSearchEngine: jest.fn() };
  const indexExtensionPoint = {
    addCollator: jest.fn(),
    addDecorator: jest.fn(),
  };

  const start = (data: unknown) =>
    startTestBackend({
      extensionPoints: [
        [searchEngineRegistryExtensionPoint, engineExtensionPoint],
        [searchIndexRegistryExtensionPoint, indexExtensionPoint],
      ],
      features: [
        searchModuleSwirlEngine,
        mockServices.rootConfig.factory({ data: data as any }),
      ],
    });

  beforeEach(() => {
    jest.clearAllMocks();
    worker.use(
      http.post(`${BASE_URL}/swirl/index/config/`, () =>
        HttpResponse.json({ effective: {} }),
      ),
    );
  });

  it('registers the engine and the federated collator when SWIRL is configured', async () => {
    await start({ search: { swirl: { baseUrl: BASE_URL } } });

    expect(engineExtensionPoint.setSearchEngine).toHaveBeenCalledTimes(1);
    expect(engineExtensionPoint.setSearchEngine).toHaveBeenCalledWith(
      expect.any(SwirlSearchEngine),
    );
    expect(indexExtensionPoint.addCollator).toHaveBeenCalledTimes(1);
    expect(indexExtensionPoint.addCollator).toHaveBeenCalledWith({
      factory: expect.objectContaining({ type: 'swirl-federated' }),
      schedule: expect.objectContaining({ run: expect.any(Function) }),
    });
  });

  it('registers nothing when there is no search.swirl config', async () => {
    await start({ search: {} });

    expect(engineExtensionPoint.setSearchEngine).not.toHaveBeenCalled();
    expect(indexExtensionPoint.addCollator).not.toHaveBeenCalled();
  });

  it('skips the federated collator when the lane is switched off', async () => {
    await start({
      search: { swirl: { baseUrl: BASE_URL, federated: { enabled: false } } },
    });

    expect(engineExtensionPoint.setSearchEngine).toHaveBeenCalledTimes(1);
    expect(indexExtensionPoint.addCollator).not.toHaveBeenCalled();
  });
});
