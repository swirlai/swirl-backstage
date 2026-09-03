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
  AuthService,
  BackstageCredentials,
} from '@backstage/backend-plugin-api';

/**
 * Outcome of a single call to SWIRL. Non 2xx responses are returned rather
 * than thrown so that callers can decide what a status means; transport
 * failures still throw.
 *
 * @public
 */
export type SwirlRequestResult = {
  status: number;
  ok: boolean;
  body: any;
};

/**
 * Options for {@link SwirlClient}.
 *
 * @public
 */
export type SwirlClientOptions = {
  baseUrl: string;
  auth: AuthService;
  /** Plugin id whose JWKS SWIRL trusts. Tokens are minted for this target. */
  audience: string;
  /** Default request timeout in ms. */
  timeoutMs: number;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Thin HTTP client for the SWIRL for Backstage service. Owns URL building,
 * bearer handling and timeouts; knows nothing about search semantics.
 *
 * @public
 */
export class SwirlClient {
  private readonly baseUrl: string;
  private readonly auth: AuthService;
  private readonly audience: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SwirlClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.auth = options.auth;
    this.audience = options.audience;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  /**
   * Mints a plugin token for SWIRL. Used by the indexer, by the startup
   * tuning call, and by queries that arrive without a router supplied token.
   */
  async mintToken(credentials?: BackstageCredentials): Promise<string> {
    const onBehalfOf =
      credentials ?? (await this.auth.getOwnServiceCredentials());
    const { token } = await this.auth.getPluginRequestToken({
      onBehalfOf,
      targetPluginId: this.audience,
    });
    return token;
  }

  /**
   * Builds an absolute URL against the configured base URL. Undefined and
   * null query values are dropped.
   */
  url(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request(options: {
    url: string;
    method: 'GET' | 'POST' | 'DELETE';
    token: string;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<SwirlRequestResult> {
    const response = await this.fetchImpl(options.url, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
    });

    let body: any;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
    }

    return { status: response.status, ok: response.ok, body };
  }
}
