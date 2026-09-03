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
import {
  mockServices,
  registerMswTestHooks,
} from '@backstage/backend-test-utils';
import { TestPipeline } from '@backstage/plugin-search-backend-node';
import { IndexableDocument } from '@backstage/plugin-search-common';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { SwirlClient } from './SwirlClient';
import { SwirlIndexer } from './SwirlIndexer';

const BASE_URL = 'http://swirl.test:8000';

const documents = (count: number): IndexableDocument[] =>
  Array.from({ length: count }, (_, index) => ({
    title: `Document ${index}`,
    text: `The body of document ${index}`,
    location: `/catalog/default/component/document-${index}`,
  }));

describe('SwirlIndexer', () => {
  const worker = setupServer();
  registerMswTestHooks(worker);

  const logger = mockServices.logger.mock();

  let calls: { method: string; path: string; body?: any }[];

  const record = (path: string, respond: () => any) =>
    http.post(`${BASE_URL}${path}`, async ({ request }) => {
      let body: any;
      try {
        body = await request.clone().json();
      } catch {
        body = undefined;
      }
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body,
      });
      return respond();
    });

  const newIndexer = (options?: { type?: string; batchSize?: number }) =>
    new SwirlIndexer({
      type: options?.type ?? 'software-catalog',
      batchSize: options?.batchSize ?? 2,
      client: new SwirlClient({
        baseUrl: BASE_URL,
        auth: mockServices.auth(),
        audience: 'search',
        timeoutMs: 5000,
      }),
      logger,
      retryBaseDelayMs: 1,
    });

  beforeEach(() => {
    calls = [];
  });

  it('begins a generation, posts every batch, then finalizes', async () => {
    worker.use(
      record('/swirl/index/software-catalog/begin/', () =>
        HttpResponse.json({ generation: '20260903-120000' }, { status: 201 }),
      ),
      record('/swirl/index/software-catalog/20260903-120000/docs/', () =>
        HttpResponse.json({ accepted: 2 }, { status: 202 }),
      ),
      record('/swirl/index/software-catalog/20260903-120000/finalize/', () =>
        HttpResponse.json({ live: '20260903-120000', count: 5 }),
      ),
    );

    const { error } = await TestPipeline.fromIndexer(newIndexer())
      .withDocuments(documents(5))
      .execute();

    expect(error).toBeFalsy();
    expect(calls.map(call => call.path)).toEqual([
      '/swirl/index/software-catalog/begin/',
      '/swirl/index/software-catalog/20260903-120000/docs/',
      '/swirl/index/software-catalog/20260903-120000/docs/',
      '/swirl/index/software-catalog/20260903-120000/docs/',
      '/swirl/index/software-catalog/20260903-120000/finalize/',
    ]);
    expect(calls[1].body.documents).toHaveLength(2);
    expect(calls[3].body.documents).toHaveLength(1);
    expect(calls[3].body.documents[0].title).toBe('Document 4');
  });

  it('sends a bearer token on every call', async () => {
    const seen: (string | null)[] = [];
    worker.use(
      http.post(`${BASE_URL}/swirl/index/:type/begin/`, ({ request }) => {
        seen.push(request.headers.get('authorization'));
        return HttpResponse.json({ generation: 'gen-1' }, { status: 201 });
      }),
      http.post(`${BASE_URL}/swirl/index/:type/:gen/docs/`, ({ request }) => {
        seen.push(request.headers.get('authorization'));
        return HttpResponse.json({ accepted: 1 }, { status: 202 });
      }),
      http.post(
        `${BASE_URL}/swirl/index/:type/:gen/finalize/`,
        ({ request }) => {
          seen.push(request.headers.get('authorization'));
          return HttpResponse.json({ live: 'gen-1', count: 1 });
        },
      ),
    );

    const { error } = await TestPipeline.fromIndexer(newIndexer())
      .withDocuments(documents(1))
      .execute();

    expect(error).toBeFalsy();
    expect(seen).toHaveLength(3);
    for (const header of seen) {
      expect(header).toMatch(/^Bearer .+/);
    }
  });

  it('aborts instead of finalizing when it received zero documents', async () => {
    worker.use(
      record('/swirl/index/software-catalog/begin/', () =>
        HttpResponse.json({ generation: 'gen-1' }, { status: 201 }),
      ),
      record('/swirl/index/software-catalog/gen-1/abort/', () =>
        HttpResponse.json(null, { status: 204 }),
      ),
      record('/swirl/index/software-catalog/gen-1/finalize/', () =>
        HttpResponse.json({ live: 'gen-1', count: 0 }),
      ),
    );

    const { error } = await TestPipeline.fromIndexer(newIndexer())
      .withDocuments([])
      .execute();

    expect(error).toBeFalsy();
    expect(calls.map(call => call.path)).toEqual([
      '/swirl/index/software-catalog/begin/',
      '/swirl/index/software-catalog/gen-1/abort/',
    ]);
    expect(logger.child).toHaveBeenCalledWith({
      documentType: 'software-catalog',
    });
  });

  it('retries a 5xx on a batch and carries on when it clears', async () => {
    let attempts = 0;
    worker.use(
      record('/swirl/index/software-catalog/begin/', () =>
        HttpResponse.json({ generation: 'gen-1' }, { status: 201 }),
      ),
      record('/swirl/index/software-catalog/gen-1/docs/', () => {
        attempts += 1;
        return attempts < 3
          ? HttpResponse.json({ detail: 'busy' }, { status: 503 })
          : HttpResponse.json({ accepted: 2 }, { status: 202 });
      }),
      record('/swirl/index/software-catalog/gen-1/finalize/', () =>
        HttpResponse.json({ live: 'gen-1', count: 2 }),
      ),
    );

    const { error } = await TestPipeline.fromIndexer(newIndexer())
      .withDocuments(documents(2))
      .execute();

    expect(error).toBeFalsy();
    expect(attempts).toBe(3);
    expect(calls[calls.length - 1].path).toBe(
      '/swirl/index/software-catalog/gen-1/finalize/',
    );
  });

  it('gives up after three retries and errors the stream', async () => {
    let attempts = 0;
    worker.use(
      record('/swirl/index/software-catalog/begin/', () =>
        HttpResponse.json({ generation: 'gen-1' }, { status: 201 }),
      ),
      record('/swirl/index/software-catalog/gen-1/docs/', () => {
        attempts += 1;
        return HttpResponse.json({ detail: 'boom' }, { status: 500 });
      }),
      record('/swirl/index/software-catalog/gen-1/abort/', () =>
        HttpResponse.json(null, { status: 204 }),
      ),
    );

    const { error } = await TestPipeline.fromIndexer(newIndexer())
      .withDocuments(documents(2))
      .execute();

    expect(attempts).toBe(4);
    expect(String(error)).toMatch(/failed after 4 attempts/);
    expect(calls.map(call => call.path)).toContain(
      '/swirl/index/software-catalog/gen-1/abort/',
    );
  });

  it('does not finalize a generation whose batch was rejected outright', async () => {
    worker.use(
      record('/swirl/index/software-catalog/begin/', () =>
        HttpResponse.json({ generation: 'gen-1' }, { status: 201 }),
      ),
      record('/swirl/index/software-catalog/gen-1/docs/', () =>
        HttpResponse.json(
          { detail: 'document 1 is missing "location"', index: 1 },
          { status: 400 },
        ),
      ),
      record('/swirl/index/software-catalog/gen-1/abort/', () =>
        HttpResponse.json(null, { status: 204 }),
      ),
    );

    const { error } = await TestPipeline.fromIndexer(newIndexer())
      .withDocuments(documents(2))
      .execute();

    expect(String(error)).toMatch(/HTTP 400/);
    expect(calls.map(call => call.path)).toEqual([
      '/swirl/index/software-catalog/begin/',
      '/swirl/index/software-catalog/gen-1/docs/',
      '/swirl/index/software-catalog/gen-1/abort/',
    ]);
  });

  it('aborts the open generation when the pipeline fails upstream', async () => {
    worker.use(
      record('/swirl/index/software-catalog/begin/', () =>
        HttpResponse.json({ generation: 'gen-1' }, { status: 201 }),
      ),
      record('/swirl/index/software-catalog/gen-1/abort/', () =>
        HttpResponse.json(null, { status: 204 }),
      ),
    );

    const collator = new Readable({ objectMode: true });
    collator._read = () => {};
    process.nextTick(() => {
      collator.destroy(new Error('the collator gave up'));
    });

    const { error } = await TestPipeline.fromIndexer(newIndexer())
      .withCollator(collator)
      .execute();

    expect(String(error)).toMatch(/the collator gave up/);
    expect(calls.map(call => call.path)).toEqual([
      '/swirl/index/software-catalog/begin/',
      '/swirl/index/software-catalog/gen-1/abort/',
    ]);
  });

  it('errors the stream when SWIRL refuses to open a generation', async () => {
    worker.use(
      record('/swirl/index/software-catalog/begin/', () =>
        HttpResponse.json(
          { detail: 'a generation is already open' },
          { status: 409 },
        ),
      ),
    );

    const { error } = await TestPipeline.fromIndexer(newIndexer())
      .withDocuments(documents(1))
      .execute();

    expect(String(error)).toMatch(/refused to open a generation/);
    expect(calls.map(call => call.path)).toEqual([
      '/swirl/index/software-catalog/begin/',
    ]);
  });
});
