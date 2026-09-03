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

// A federated source that only SWIRL can see. SWIRL calls it through a
// RequestsGet SearchProvider (see register-provider.js); Backstage never talks
// to it, which is the whole point of the federated assertion.
//
// GET /search?q=<term> -> { count, results: [ { title, body, url }, ... ] }
//
// Node only, no dependencies: node server.js

const http = require('node:http');

const PORT = Number(process.env.STUB_PROVIDER_PORT ?? 8012);

// Results carry a hostname that exists nowhere else in the run, so an
// assertion on the location of a federated result cannot pass by accident on a
// document that came out of the Backstage catalog.
const HOST = 'http://stub.e2e.invalid';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname !== '/search') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: `no route for ${req.url}` }));
    return;
  }

  const term = url.searchParams.get('q') ?? '';
  const results = [
    {
      title: `Stub runbook for ${term}`,
      body: `A runbook about ${term} that lives outside Backstage, in the system this stub stands in for.`,
      url: `${HOST}/doc/1?q=${encodeURIComponent(term)}`,
    },
    {
      title: `Stub incident report for ${term}`,
      body: `An incident report mentioning ${term}, also outside Backstage.`,
      url: `${HOST}/doc/2?q=${encodeURIComponent(term)}`,
    },
  ];

  const payload = JSON.stringify({ count: results.length, results });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`stub-provider listening on http://localhost:${PORT}`);
});
