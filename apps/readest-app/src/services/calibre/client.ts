import type {
  CalibreBookJson,
  CalibreLibraryInfo,
  CalibrePosition,
  CalibreSearchResult,
  CalibreServer,
} from '@/types/calibre';
import { isTauriAppPlatform } from '@/services/environment';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { fetchWithAuth, needsProxy, probeAuth } from '@/app/opds/utils/opdsReq';

/**
 * Platform fetch resolved at call time (never at module scope): this module
 * is part of the library page's import graph, which Next.js also evaluates
 * on the server during the web build, where `window` does not exist.
 */
const platformFetch = (): typeof fetch => (isTauriAppPlatform() ? tauriFetch : window.fetch);

/**
 * Client for the official Calibre content server JSON API
 * (calibre/src/calibre/srv/{ajax,books,content}.py). Auth reuses the OPDS
 * machinery (Basic preemptive + Digest challenge retry, including calibre's
 * 400-rejects-Basic quirk in digest mode). On the web platform requests go
 * through the OPDS proxy, which supports Basic auth only.
 */
export class CalibreClient {
  private server: CalibreServer;
  /**
   * A Basic Authorization header that already authenticated once. Reusable
   * verbatim across requests; Digest headers are bound to one request URI
   * (the response hash covers uri) so they are renegotiated per request via
   * fetchWithAuth instead of being cached.
   */
  private cachedBasicAuth: string | null = null;
  /** Set after the one-time auth-scheme probe so it never runs again. */
  private authProbed = false;

  constructor(server: CalibreServer) {
    this.server = server;
  }

  /** Base URL without trailing slash; user-supplied path prefixes survive. */
  private base(): string {
    return this.server.url.trim().replace(/\/+$/, '');
  }

  /** Library id for a URL path segment (library ids are folder names, so escape them). */
  private static libSeg(libraryId: string): string {
    return encodeURIComponent(libraryId);
  }

  private buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
    let url = `${this.base()}${path}`;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    const qs = search.toString();
    if (qs) url += `?${qs}`;
    return url;
  }

  private async fetchJSON<T>(path: string, params?: Record<string, string | number | undefined>) {
    const res = await this.authedFetch(this.buildUrl(path, params), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Calibre request failed: ${path} -> ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private rawFetch(url: string, options: RequestInit): Promise<Response> {
    return platformFetch()(url, {
      ...options,
      // Calibre self-hosted deployments commonly run self-signed certificates.
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
    } as RequestInit);
  }

  /**
   * Authenticated request with a cached-Basic fast path. Anything not 401/400
   * returns directly; otherwise the cache is dropped and fetchWithAuth
   * renegotiates the scheme the server actually wants (calibre's digest mode
   * answers a Basic header with 400, see fetchWithAuth). Public because
   * small authenticated downloads (covers) ride it directly.
   */
  async authedFetch(url: string, options: RequestInit = {}): Promise<Response> {
    if (this.cachedBasicAuth) {
      const res = await this.rawFetch(url, {
        ...options,
        headers: {
          ...(options.headers as Record<string, string>),
          Authorization: this.cachedBasicAuth,
        },
      });
      if (res.status !== 401 && res.status !== 400) return res;
      this.cachedBasicAuth = null;
    }
    const res = await fetchWithAuth(
      url,
      this.server.username,
      this.server.password,
      needsProxy(url),
      options,
    );
    if (res.ok && this.server.username && this.server.password && !this.authProbed) {
      // One-time scheme probe after the first authenticated request: a Basic
      // header is reusable verbatim across requests, a Digest one is bound to
      // its request uri (the response hash covers uri), so only Basic gets
      // cached and digest keeps renegotiating via fetchWithAuth.
      this.authProbed = true;
      try {
        const auth = await probeAuth(
          this.buildUrl('/ajax/library-info'),
          this.server.username,
          this.server.password,
          needsProxy(this.server.url),
        );
        if (auth?.startsWith('Basic ')) this.cachedBasicAuth = auth;
      } catch {
        // Cache stays empty; fetchWithAuth remains the correct path.
      }
    }
    return res;
  }

  /** GET /ajax/library-info -> library list + default library. */
  async getLibraryInfo(): Promise<CalibreLibraryInfo> {
    const data = await this.fetchJSON<{
      library_map: Record<string, string>;
      default_library: string;
    }>('/ajax/library-info');
    const libraries = Object.entries(data.library_map ?? {}).map(([id, name]) => ({
      id,
      name: name || id,
    }));
    return { libraries, defaultLibraryId: data.default_library };
  }

  /** GET /ajax/search -> one page of matching book ids. */
  async searchBookIds(
    libraryId: string,
    opts: {
      query?: string;
      sort?: string;
      sortOrder?: 'asc' | 'desc';
      num?: number;
      offset?: number;
    } = {},
  ): Promise<CalibreSearchResult> {
    return this.fetchJSON<CalibreSearchResult>(`/ajax/search/${CalibreClient.libSeg(libraryId)}`, {
      query: opts.query,
      sort: opts.sort,
      sort_order: opts.sortOrder,
      num: opts.num,
      offset: opts.offset,
    });
  }

  /**
   * All book ids in the library, paged. The server caps `num` per response,
   * so loop on `offset` until a page comes back short; an explicit large
   * `total_num` bounds the loop against misbehaving servers.
   */
  async getAllBookIds(libraryId: string, pageSize = 500): Promise<number[]> {
    const ids: number[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const page = await this.searchBookIds(libraryId, { num: pageSize, offset });
      const batch = page.book_ids ?? [];
      ids.push(...batch);
      total = typeof page.total_num === 'number' ? page.total_num : offset + batch.length;
      if (batch.length === 0) break;
      offset += batch.length;
    }
    return ids;
  }

  /** GET /ajax/books?ids=... -> { bookId: bookJson | null } (restricted books are null). */
  async getBooks(
    libraryId: string,
    bookIds: number[],
  ): Promise<Record<string, CalibreBookJson | null>> {
    if (bookIds.length === 0) return {};
    return this.fetchJSON<Record<string, CalibreBookJson | null>>(
      `/ajax/books/${CalibreClient.libSeg(libraryId)}`,
      { ids: bookIds.join(','), id_is_uuid: 'false' },
    );
  }

  /** Authenticated thumbnail URL (JPEG) for grid covers. */
  buildThumbUrl(libraryId: string, bookId: string | number, size = '400x600'): string {
    return this.buildUrl(`/get/thumb/${bookId}/${CalibreClient.libSeg(libraryId)}`, { sz: size });
  }

  /** Authenticated full cover URL. */
  buildCoverUrl(libraryId: string, bookId: string | number): string {
    return this.buildUrl(`/get/cover/${bookId}/${CalibreClient.libSeg(libraryId)}`);
  }

  /** Authenticated download URL for one format (lowercase ext, e.g. `epub`). */
  buildDownloadUrl(libraryId: string, bookId: string | number, fmt: string): string {
    return this.buildUrl(`/get/${fmt.toLowerCase()}/${bookId}/${CalibreClient.libSeg(libraryId)}`);
  }

  /**
   * GET /book-get-last-read-position -> positions keyed `"<bookId>:<fmt>"`.
   * `which` lists the pairs to query in the server's wire form
   * `bookId1-fmt1_bookId2-fmt2` (srv/books.py splits on `_`, pairs on `-`).
   */
  async getLastReadPosition(
    libraryId: string,
    which: string[],
  ): Promise<Record<string, CalibrePosition[]>> {
    if (which.length === 0) return {};
    return this.fetchJSON<Record<string, CalibrePosition[]>>(
      `/book-get-last-read-position/${CalibreClient.libSeg(libraryId)}/${which.join('_')}`,
    );
  }

  /** POST /book-set-last-read-position — store a per-user reading position. */
  async setLastReadPosition(
    libraryId: string,
    bookId: string | number,
    fmt: string,
    position: { device: string; cfi: string; pos_frac: number },
  ): Promise<void> {
    const res = await this.authedFetch(
      this.buildUrl(
        `/book-set-last-read-position/${CalibreClient.libSeg(libraryId)}/${bookId}/${fmt.toLowerCase()}`,
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(position),
      },
    );
    if (!res.ok) {
      throw new Error(`Calibre position push failed: ${res.status}`);
    }
  }
}

/** A fresh client for the server row; the row's current credentials are read per request. */
export const createCalibreClient = (server: CalibreServer): CalibreClient =>
  new CalibreClient(server);
