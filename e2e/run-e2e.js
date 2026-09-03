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

// The single entry point for the end to end run: `yarn e2e`.
//
//   1. docker compose up the SWIRL for Backstage container (project swirl-e2e)
//   2. wait for GET /swirl/sapi/health/backstage/
//   3. start the stub federated source on the host
//   4. register it in SWIRL as a RequestsGet SearchProvider tagged "backstage"
//   5. start the e2e Backstage backend on 7100
//   6. wait for a guest token and for GET /swirl/index/ to show
//      software-catalog live, which means the collator has run
//   7. run jest
//   8. tear all of it down again
//
// Flags:
//   --keep   leave the container, the stub and the backend running afterwards
//   --no-up  assume everything is already running (use with a previous --keep)

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const E2E_DIR = __dirname;
const REPO_ROOT = path.resolve(E2E_DIR, '..');
const APP_DIR = path.join(E2E_DIR, 'app');
const COMPOSE_FILE = path.join(E2E_DIR, 'compose.yaml');
const LOG_DIR = path.join(E2E_DIR, '.logs');

const PROJECT = 'swirl-e2e';
const SWIRL_PORT = 8011;
const BACKEND_PORT = 7100;
const STUB_PORT = Number(process.env.STUB_PROVIDER_PORT ?? 8012);
const SWIRL_URL = `http://localhost:${SWIRL_PORT}`;
const BACKSTAGE_URL = `http://localhost:${BACKEND_PORT}`;
const ADMIN_PASSWORD =
  process.env.SWIRL_E2E_ADMIN_PASSWORD ?? 'swirl-e2e-local';

const KEEP = process.argv.includes('--keep');
const NO_UP = process.argv.includes('--no-up');

const BACKEND_LOG = path.join(LOG_DIR, 'backend.log');
const STUB_LOG = path.join(LOG_DIR, 'stub-provider.log');

const children = [];

const log = message => console.log(`[e2e] ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${
        result.status ?? result.signal
      }`,
    );
  }
}

/** Start a long lived child in its own process group so it can be killed whole. */
function background(command, args, { cwd, logFile, env }) {
  const out = fs.openSync(logFile, 'w');
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...(env ?? {}) },
  });
  children.push(child);
  return child;
}

function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function waitFor(what, check, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        log(`${what}: ready`);
        return;
      }
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out after ${timeoutMs} ms waiting for ${what}${
      last ? `: ${last.message}` : ''
    }`,
  );
}

const swirlHealthy = async () => {
  const response = await fetch(`${SWIRL_URL}/swirl/sapi/health/backstage/`, {
    signal: AbortSignal.timeout(4000),
  });
  return response.ok && (await response.json()).ok === true;
};

const guestTokenReady = async () => {
  const response = await fetch(`${BACKSTAGE_URL}/api/auth/guest/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) {
    return false;
  }
  const body = await response.json();
  if (!body?.backstageIdentity?.token) {
    throw new Error(
      'the guest refresh response has no backstageIdentity.token; the shape ' +
        `the tests read has changed: ${JSON.stringify(body)}`,
    );
  }
  return true;
};

const catalogIndexLive = async () => {
  const response = await fetch(`${SWIRL_URL}/swirl/index/`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString(
        'base64',
      )}`,
    },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) {
    return false;
  }
  const body = await response.json();
  const entry = body.types?.find(item => item.type === 'software-catalog');
  return Boolean(entry?.live) && entry.doc_count > 0;
};

function teardown() {
  if (KEEP) {
    log('--keep: leaving the container, the stub and the backend running');
    log(`  backend log: ${BACKEND_LOG}`);
    return;
  }

  for (const child of children) {
    try {
      // Negative pid kills the whole process group, which is what the yarn
      // wrapper around backstage-cli needs.
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  children.length = 0;

  log('docker compose down');
  spawnSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'down', '-v'],
    { stdio: 'inherit' },
  );
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  if (!NO_UP) {
    for (const [port, what] of [
      [BACKEND_PORT, 'the e2e Backstage backend'],
      [STUB_PORT, 'the stub federated source'],
    ]) {
      if (!(await portFree(port))) {
        throw new Error(
          `port ${port} is already in use, and ${what} needs it. Stop whatever ` +
            'is listening there, or run with --no-up against your own stack.',
        );
      }
    }

    log(`docker compose up (project ${PROJECT}, SWIRL on ${SWIRL_PORT})`);
    run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'up', '-d'], {
      env: { SWIRL_E2E_ADMIN_PASSWORD: ADMIN_PASSWORD },
    });

    await waitFor('SWIRL health', swirlHealthy, 240000);

    log(`starting the stub federated source on ${STUB_PORT}`);
    background(
      process.execPath,
      [path.join(E2E_DIR, 'fixtures', 'stub-provider', 'server.js')],
      {
        cwd: E2E_DIR,
        logFile: STUB_LOG,
        env: { STUB_PROVIDER_PORT: String(STUB_PORT) },
      },
    );
    await waitFor(
      'the stub federated source',
      async () =>
        (
          await fetch(`http://localhost:${STUB_PORT}/search?q=ping`)
        ).ok,
      30000,
    );

    log('registering the stub SearchProvider in SWIRL');
    run(
      process.execPath,
      [path.join(E2E_DIR, 'fixtures', 'register-provider.js')],
      {
        env: {
          SWIRL_E2E_URL: SWIRL_URL,
          SWIRL_E2E_ADMIN_PASSWORD: ADMIN_PASSWORD,
          STUB_PROVIDER_PORT: String(STUB_PORT),
        },
      },
    );

    log(`starting the e2e Backstage backend on ${BACKEND_PORT}`);
    background('yarn', ['workspace', 'backend', 'start'], {
      cwd: APP_DIR,
      logFile: BACKEND_LOG,
    });

    await waitFor('a guest token from the backend', guestTokenReady, 240000);
    await waitFor(
      'the software-catalog index to go live in SWIRL',
      catalogIndexLive,
      240000,
    );
  } else {
    log('--no-up: using the stack that is already running');
  }

  log('running jest');
  const jest = spawnSync(
    'yarn',
    ['jest', '--config', path.join(E2E_DIR, 'jest.config.js'), '--runInBand'],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        E2E_BACKSTAGE_URL: BACKSTAGE_URL,
        E2E_SWIRL_URL: SWIRL_URL,
        E2E_BACKEND_LOG: BACKEND_LOG,
        E2E_COMPOSE_PROJECT: PROJECT,
        E2E_COMPOSE_FILE: COMPOSE_FILE,
        SWIRL_E2E_ADMIN_PASSWORD: ADMIN_PASSWORD,
      },
    },
  );

  return jest.status ?? 1;
}

let exitCode = 1;
process.on('SIGINT', () => {
  teardown();
  process.exit(130);
});

main()
  .then(code => {
    exitCode = code;
  })
  .catch(error => {
    console.error(`[e2e] ${error.message}`);
    if (fs.existsSync(BACKEND_LOG)) {
      console.error(`[e2e] the backend log is at ${BACKEND_LOG}`);
    }
    console.error(
      `[e2e] the SWIRL container log: docker compose -p ${PROJECT} logs`,
    );
    exitCode = 1;
  })
  .finally(() => {
    teardown();
    process.exit(exitCode);
  });
