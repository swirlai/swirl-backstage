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

// An in-memory stand-in for SWIRL, good enough to drive the engine module by
// hand before the real image exists. Substring matching, no relevance, no auth
// beyond requiring a bearer. Node only, no dependencies: node server.js

const http = require('node:http');

const PORT = Number(process.env.PORT ?? 8000);
const TYPE = /^[a-z0-9-]{1,64}$/;

const live = new Map(); // type -> { generation, documents }
const open = new Map(); // type -> { generation, documents }
const searches = new Map(); // id -> results
let tuning = {};
let nextSearchId = 1;

const send = (res, status, body) => {
  if (status === 204 || body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  }).end(payload);
};

const readJson = req =>
  new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(undefined);
      }
    });
  });

const asResult = (doc, type, rank, term) => ({
  swirl_rank: rank,
  swirl_score: 1,
  searchprovider: type ? 'Backstage Index' : 'Stub Provider',
  title: doc.title ?? '',
  url: doc.location ?? '',
  body: doc.text ?? '',
  title_hit_highlights: mark(doc.title ?? '', term),
  body_hit_highlights: mark(doc.text ?? '', term),
  payload: type ? { backstage: { type, document: doc } } : {},
});

const mark = (value, term) =>
  term && value.toLowerCase().includes(term.toLowerCase())
    ? [value.replace(new RegExp(`(${term})`, 'ig'), '*$1*')]
    : [];

const matches = (doc, term) =>
  !term ||
  `${doc.title ?? ''} ${doc.text ?? ''}`.toLowerCase().includes(term.toLowerCase());

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const parts = path.split('/').filter(Boolean); // swirl, index, <type>, ...

  if (!(req.headers.authorization ?? '').startsWith('Bearer ')) {
    return send(res, 401, { detail: 'a bearer token is required' });
  }

  // POST /swirl/index/config/
  if (req.method === 'POST' && path === '/swirl/index/config/') {
    tuning = (await readJson(req)) ?? {};
    return send(res, 200, tuning);
  }

  // GET /swirl/index/
  if (req.method === 'GET' && path === '/swirl/index/') {
    return send(
      res,
      200,
      [...live.entries()].map(([type, entry]) => ({
        type,
        generation: entry.generation,
        count: entry.documents.length,
      })),
    );
  }

  if (parts[0] === 'swirl' && parts[1] === 'index' && parts[2]) {
    const type = decodeURIComponent(parts[2]);
    if (!TYPE.test(type)) {
      return send(res, 400, { detail: `invalid type name: ${type}` });
    }

    // POST /swirl/index/<type>/begin/
    if (req.method === 'POST' && parts[3] === 'begin' && parts.length === 4) {
      if (open.has(type)) {
        return send(res, 409, { detail: 'a generation is already open' });
      }
      const generation = String(Date.now());
      open.set(type, { generation, documents: [] });
      return send(res, 201, { generation });
    }

    // DELETE /swirl/index/<type>/
    if (req.method === 'DELETE' && parts.length === 3) {
      live.delete(type);
      open.delete(type);
      return send(res, 204);
    }

    const entry = open.get(type);
    const generation = parts[3];
    const action = parts[4];

    if (parts.length !== 5) {
      return send(res, 404, { detail: `no route for ${req.method} ${path}` });
    }

    if (!entry || entry.generation !== generation) {
      return send(res, 404, { detail: `no open generation ${generation}` });
    }

    // POST /swirl/index/<type>/<gen>/docs/
    if (req.method === 'POST' && action === 'docs') {
      const body = await readJson(req);
      const documents = body?.documents;
      if (!Array.isArray(documents) || documents.length > 1000) {
        return send(res, 400, { detail: 'documents must be an array of <= 1000' });
      }
      const bad = documents.findIndex(
        doc => !doc?.title || !doc?.text || !doc?.location,
      );
      if (bad !== -1) {
        return send(res, 400, {
          detail: 'every document needs title, text and location',
          index: bad,
        });
      }
      entry.documents.push(...documents);
      return send(res, 202, { accepted: documents.length, generation });
    }

    // POST /swirl/index/<type>/<gen>/finalize/
    if (req.method === 'POST' && action === 'finalize') {
      if (entry.documents.length === 0) {
        return send(res, 400, { detail: 'refusing to finalize zero documents' });
      }
      live.set(type, entry);
      open.delete(type);
      return send(res, 200, {
        live: generation,
        count: entry.documents.length,
      });
    }

    // POST /swirl/index/<type>/<gen>/abort/
    if (req.method === 'POST' && action === 'abort') {
      open.delete(type);
      return send(res, 204);
    }
  }

  // GET /swirl/search/
  if (req.method === 'GET' && path === '/swirl/search/') {
    const term = url.searchParams.get('qs') ?? '';
    const wanted = (url.searchParams.get('backstage_types') ?? '')
      .split(',')
      .filter(Boolean);
    const providers = (url.searchParams.get('providers') ?? '').split(',');

    const missing = wanted.filter(type => !live.has(type));
    if (missing.length) {
      return send(res, 404, { error: 'missing_index', types: missing });
    }

    const hits = [];
    for (const [type, entry] of live.entries()) {
      if (wanted.length && !wanted.includes(type)) continue;
      for (const doc of entry.documents) {
        if (matches(doc, term)) hits.push([doc, type]);
      }
    }

    // Anything beyond backstage-index stands in for a federated provider.
    if (providers.some(tag => tag && tag !== 'backstage-index')) {
      hits.push([
        {
          title: `Stub federated hit for ${term}`,
          text: `A result that only SWIRL can see, for ${term}`,
          location: 'https://stub.invalid/1',
        },
        undefined,
      ]);
    }

    const id = nextSearchId++;
    const results = hits.map(([doc, type], index) =>
      asResult(doc, type, index + 1, term),
    );
    searches.set(id, results);

    return send(res, 200, envelope(id, results, url));
  }

  // GET /swirl/results/
  if (req.method === 'GET' && path === '/swirl/results/') {
    const id = Number(url.searchParams.get('search_id'));
    const results = searches.get(id);
    if (!results) {
      return send(res, 404, { detail: `no such search ${id}` });
    }
    return send(res, 200, envelope(id, results, url));
  }

  return send(res, 404, { detail: `no route for ${req.method} ${path}` });
});

function envelope(id, results, url) {
  const size = Number(url.searchParams.get('results_requested') ?? 25);
  const page = Number(url.searchParams.get('page') ?? 1);
  const start = (page - 1) * size;

  return {
    messages: ['stub-swirl'],
    info: {
      search: { id },
      results: {
        found_total: results.length,
        retrieved_total: results.length,
      },
    },
    results: results.slice(start, start + size),
  };
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`stub-swirl listening on http://localhost:${PORT}`);
});
