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
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import {
  searchEngineRegistryExtensionPoint,
  searchIndexRegistryExtensionPoint,
} from '@backstage/plugin-search-backend-node/alpha';
import { SwirlFederatedCollatorFactory } from './collators/SwirlFederatedCollatorFactory';
import { SwirlSearchEngine } from './engines/SwirlSearchEngine';

/**
 * The federated collator produces nothing, so it only needs to run often
 * enough to keep the document type registered across restarts.
 */
const FEDERATED_SCHEDULE = {
  frequency: { hours: 24 },
  timeout: { minutes: 1 },
  initialDelay: { seconds: 3 },
};

/**
 * Search backend module for the SWIRL engine.
 *
 * @public
 */
export const searchModuleSwirlEngine = createBackendModule({
  pluginId: 'search',
  moduleId: 'swirl-engine',
  register(env) {
    env.registerInit({
      deps: {
        searchEngineRegistry: searchEngineRegistryExtensionPoint,
        indexRegistry: searchIndexRegistryExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        auth: coreServices.auth,
        scheduler: coreServices.scheduler,
      },
      async init({
        searchEngineRegistry,
        indexRegistry,
        config,
        logger,
        auth,
        scheduler,
      }) {
        // Without config there is nothing to point at. Warn and step aside so
        // the search plugin keeps whatever engine it already has, rather than
        // throwing on a second engine registration.
        if (!config.getOptionalConfig('search.swirl')) {
          logger.warn(
            'No configuration found under "search.swirl". Skipping registration of the SWIRL search engine.',
          );
          return;
        }

        searchEngineRegistry.setSearchEngine(
          await SwirlSearchEngine.fromConfig(config, { logger, auth }),
        );

        const federatedEnabled =
          config.getOptionalBoolean('search.swirl.federated.enabled') ?? true;

        if (federatedEnabled) {
          indexRegistry.addCollator({
            schedule: scheduler.createScheduledTaskRunner(FEDERATED_SCHEDULE),
            factory: SwirlFederatedCollatorFactory.fromConfig(config, {
              logger,
            }),
          });
        } else {
          logger.info(
            'The SWIRL federated document type is disabled by "search.swirl.federated.enabled"; federated results will not be returned.',
          );
        }
      },
    });
  },
});

export default searchModuleSwirlEngine;
