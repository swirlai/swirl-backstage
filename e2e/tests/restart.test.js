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

// The Tantivy index lives on the /data volume, so a container that comes back
// answers the same query from the same generation with no collator run in
// between. Two separate properties are asserted here, because today only one
// of them holds:
//
//   1. `docker compose restart` brings the container back healthy. It does
//      not: the entrypoint refuses to restart Celery, so the health endpoint
//      never leaves 503 and /swirl/search/ has no worker. That is an image
//      defect, not an index defect. See e2e/README.md, "Known SWIRL-side
//      defects".
//   2. The index itself survives the container. It does, and the second case
//      proves it on a freshly created container against the same volume.
//
// This file must run last. e2e/testSequencer.js makes sure of that.

const { execFileSync } = require('node:child_process');
const {
  liveGeneration,
  search,
  sleep,
  titles,
  SWIRL_URL,
} = require('./support');

const PROJECT = process.env.E2E_COMPOSE_PROJECT ?? 'swirl-e2e';
const COMPOSE_FILE =
  process.env.E2E_COMPOSE_FILE ?? `${__dirname}/../compose.yaml`;

const compose = (...args) =>
  execFileSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args],
    {
      stdio: 'pipe',
      encoding: 'utf-8',
    },
  );

async function health() {
  const response = await fetch(`${SWIRL_URL}/swirl/sapi/health/backstage/`, {
    signal: AbortSignal.timeout(4000),
  });
  return response.json();
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await health();
      if (last.ok === true) {
        return true;
      }
    } catch {
      last = undefined;
    }
    await sleep(1000);
  }
  return last ?? false;
}

/** The last line of the container log that explains a refusal to start Celery. */
function celeryRefusal() {
  const logs = compose('logs', '--no-log-prefix', '--tail', '400');
  return (
    logs.split('\n').find(line => line.includes('is already running')) ??
    '(no "is already running" line in the container log)'
  );
}

describe('the SWIRL container coming back', () => {
  jest.setTimeout(420000);

  it('comes back healthy after docker compose restart', async () => {
    expect(await liveGeneration('software-catalog')).toBeTruthy();

    compose('restart', 'swirl');

    const result = await waitForHealth(150000);
    if (result !== true) {
      throw new Error(
        'the SWIRL container did not become healthy again within 150 s after ' +
          `docker compose restart. Health: ${JSON.stringify(result)}. ` +
          `Container log: ${celeryRefusal().trim()}`,
      );
    }
  });

  it('answers "store" from the same on-disk generation, with no collator run in between', async () => {
    // Recreate rather than restart, so the previous case's defect does not
    // hide this one. A new container, the same /data volume: if the index were
    // in memory it would be empty here, and the generation id would change.
    //
    // The Backstage collator finalizes a new generation every 30 seconds
    // whatever this test is doing, so the generation is read immediately
    // before the recreate and immediately after health. A collator run that
    // lands inside that sliver moves the id for a reason that has nothing to
    // do with persistence, and the attempt is simply retried.
    let before;
    let after;

    for (let attempt = 1; attempt <= 3; attempt++) {
      before = await liveGeneration('software-catalog');
      expect(before).toBeTruthy();

      compose('up', '-d', '--force-recreate', 'swirl');
      expect(await waitForHealth(240000)).toBe(true);

      after = await liveGeneration('software-catalog');
      if (after === before) {
        break;
      }
    }

    expect(after).toBe(before);

    const result = await search({ term: 'store', types: ['software-catalog'] });
    expect(titles(result, 3)).toContain('petstore');
  });
});
