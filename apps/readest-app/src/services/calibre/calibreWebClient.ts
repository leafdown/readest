import type { CalibreBookJson } from '@/types/calibre';
import type { CalibreServerBook } from '@/services/calibre/librarySync';

/**
 * Minimal parser for Calibre-Web's OPDS acquisition feeds
 * (cps/templates/feed.xml). The feed is machine-generated, but entries mix
 * structured fields (title, authors, categories) with display-only blobs
 * (rating/series are rendered INTO the xhtml content), so the extraction
 * mirrors what the template actually emits:
 *
 *   <id>urn:uuid:{uuid}</id>                 — the calibre UUID, NOT the id
 *   <link rel=".../acquisition"
 *         href="/opds/download/{id}/{fmt}/"  — carries the NUMERIC book id
 *         title="{FORMAT}">                  — and the format name
 *   <link rel=".../image" href="/opds/cover/{id}">
 *   <content type="xhtml">RATING: ★★<br/> TAGS: ... SERIES: Name [2.0] <p>comment</p></content>
 *
 * Navigation feeds (the /opds root) render the same template without
 * acquisition links; those entries are skipped. Pagination rides the
 * rel="next" link's `?offset=` (calibre-web derives the page from
 * offset/books-per-page, so the exact server-computed href must be used,
 * not an offset we invent).
 */
export interface CalibreWebFeed {
  entries: CalibreServerBook[];
  /** href of the rel="next" link, when the feed has another page. */
  nextHref?: string;
}

const ACQUISITION_REL = 'http://opds-spec.org/acquisition';
const DOWNLOAD_HREF = /\/opds\/download\/(\d+)\/([^/?#]+)/;

const textOf = (element: Element, tag: string): string =>
  element.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';

export const parseCalibreWebFeed = (xml: string): CalibreWebFeed => {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Calibre-Web returned an invalid OPDS feed');
  }
  const root = doc.documentElement;
  if (root?.localName !== 'feed') {
    // A 302 into the login page (OPDS basic auth disabled) surfaces here.
    throw new Error(
      'Calibre-Web OPDS feed not found. Enable OPDS and basic authentication on the server.',
    );
  }

  const nextHref =
    Array.from(root.getElementsByTagName('link'))
      .find((link) => link.getAttribute('rel') === 'next')
      ?.getAttribute('href') ?? undefined;

  const entries: CalibreServerBook[] = [];
  for (const entry of Array.from(root.getElementsByTagName('entry'))) {
    const links = Array.from(entry.getElementsByTagName('link'));
    const acquisitions = links.filter((link) => link.getAttribute('rel') === ACQUISITION_REL);
    if (acquisitions.length === 0) continue; // navigation entry

    let bookId: string | undefined;
    const formats: string[] = [];
    for (const link of acquisitions) {
      const match = (link.getAttribute('href') ?? '').match(DOWNLOAD_HREF);
      if (!match) continue;
      bookId = bookId ?? match[1]!;
      // The link title is the format name (EPUB, MOBI, ...); the href's last
      // segment is the same lowercased. Prefer the title, fall back to href.
      const fmt = (link.getAttribute('title') ?? match[2] ?? '').toLowerCase();
      if (fmt && !formats.includes(fmt)) formats.push(fmt);
    }
    if (!bookId || formats.length === 0) continue;

    const json: CalibreBookJson = {
      title: textOf(entry, 'title') || 'Untitled',
      authors: Array.from(entry.getElementsByTagName('author'))
        .map((author) => textOf(author, 'name'))
        .filter(Boolean),
      formats,
      last_modified: textOf(entry, 'updated') || undefined,
      pubdate: textOf(entry, 'published') || undefined,
      languages: Array.from(entry.getElementsByTagNameNS('http://purl.org/dc/terms/', 'language'))
        .map((lang) => lang.textContent?.trim() ?? '')
        .filter(Boolean),
      tags: entry.getElementsByTagName('category').length
        ? Array.from(entry.getElementsByTagName('category'))
            .map((category) => category.getAttribute('term') ?? '')
            .filter(Boolean)
        : null,
      publisher: textOf(entry, 'publisher') || null,
      thumbnail:
        Array.from(links)
          .find((link) => (link.getAttribute('rel') ?? '').startsWith('http://opds-spec.org/image'))
          ?.getAttribute('href') ?? undefined,
    };

    // Rating/series/description only exist inside the xhtml content blob.
    const content = entry.getElementsByTagName('content')[0]?.textContent ?? '';
    const stars = content.match(/RATING:\s*([★]+)/);
    if (stars) json.rating = stars[1]!.length;
    const series = content.match(/SERIES:\s*(.+?)\s*\[([^\]]+)\]/);
    if (series) {
      json.series = series[1]!.trim();
      const index = Number.parseFloat(series[2]!);
      if (!Number.isNaN(index)) json.series_index = index;
    }
    const paragraphs = entry.getElementsByTagName('p');
    if (paragraphs.length > 0) {
      json.comments = Array.from(paragraphs)
        .map((p) => p.innerHTML?.trim() ?? p.textContent?.trim() ?? '')
        .filter(Boolean)
        .join('<br/>');
    }

    entries.push({ id: bookId, json });
  }

  return { entries, nextHref };
};
