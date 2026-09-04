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

// SWIRL has two ways of saying that a requested type has no live index: the
// hard form, a 404 whose body is {"error": "missing_index", "types": [...]},
// and the soft form, an ordinary 200 carrying a structured __MISSING_INDEX__
// entry in `messages` beside whatever the live types did match. Both are real
// and the engine has to handle both, so the stub can produce either.
//
//   STUB_SWIRL_MISSING_INDEX_FORM=soft node e2e/stub-swirl/server.js
//   GET /swirl/search/?...&stub_missing_index=soft     (per request)
const MISSING_INDEX_FORMS = ['hard', 'soft'];
const DEFAULT_MISSING_INDEX_FORM =
  process.env.STUB_SWIRL_MISSING_INDEX_FORM ?? 'hard';

if (!MISSING_INDEX_FORMS.includes(DEFAULT_MISSING_INDEX_FORM)) {
  throw new Error(
    `STUB_SWIRL_MISSING_INDEX_FORM must be one of ${MISSING_INDEX_FORMS.join(
      ', ',
    )}, not ${DEFAULT_MISSING_INDEX_FORM}`,
  );
}

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
  res
    .writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    })
    .end(payload);
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

// The marker pair SWIRL wraps hits in, from SWIRL_HIGHLIGHT_START_CHAR and
// SWIRL_HIGHLIGHT_END_CHAR.
const HIGHLIGHT_START = '<em>';
const HIGHLIGHT_END = '</em>';

const asResult = (doc, type, rank, term) => ({
  swirl_rank: rank,
  swirl_score: 1 / rank,
  searchprovider: type ? 'Backstage Index' : 'Stub Provider',
  title: doc.title ?? '',
  url: doc.location ?? '',
  body: doc.text ?? '',
  title_hit_highlights: mark(doc.title ?? '', term),
  body_hit_highlights: mark(doc.text ?? '', term),
  // SWIRL's MappingResultProcessor sweeps top level keys it does not
  // recognise into the payload, which is where the provider score lands.
  payload: {
    searchprovider_score: 1 / rank,
    ...(type ? { backstage: { type, document: doc } } : {}),
  },
});

const mark = (value, term) =>
  term && value.toLowerCase().includes(term.toLowerCase())
    ? [
        value.replace(
          new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'),
          `${HIGHLIGHT_START}$1${HIGHLIGHT_END}`,
        ),
      ]
    : [];

const matches = (doc, term) =>
  !term ||
  `${doc.title ?? ''} ${doc.text ?? ''}`
    .toLowerCase()
    .includes(term.toLowerCase());

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
    const types = new Set([...live.keys(), ...open.keys()]);
    return send(res, 200, {
      types: [...types].map(type => {
        const entry = live.get(type);
        return {
          type,
          live: entry?.generation ?? null,
          doc_count: entry?.documents.length ?? 0,
          bytes: entry ? Buffer.byteLength(JSON.stringify(entry.documents)) : 0,
          updated: entry?.updated ?? null,
          open: open.get(type)?.generation ?? null,
        };
      }),
    });
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
        return send(res, 400, {
          detail: 'documents must be an array of <= 1000',
        });
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
        return send(res, 400, {
          detail: 'refusing to finalize zero documents',
        });
      }
      entry.updated = new Date().toISOString();
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
    const form =
      url.searchParams.get('stub_missing_index') ?? DEFAULT_MISSING_INDEX_FORM;
    if (missing.length && form !== 'soft') {
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

    return send(res, 200, envelope(id, results, url, missing));
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

function envelope(id, results, url, missing = []) {
  const size = Number(url.searchParams.get('results_requested') ?? 25);
  const page = Number(url.searchParams.get('page') ?? 1);
  const start = (page - 1) * size;

  return {
    messages: [
      'stub-swirl',
      ...(missing.length
        ? [JSON.stringify({ type: '__MISSING_INDEX__', types: missing })]
        : []),
    ],
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
