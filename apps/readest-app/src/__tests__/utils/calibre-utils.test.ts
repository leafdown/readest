import { describe, expect, it } from 'vitest';
import {
  computeCalibreServerId,
  makeCalibreFilePath,
  parseCalibreFilePath,
  pickPreferredFormat,
} from '@/utils/calibre';

describe('pickPreferredFormat', () => {
  it('prefers EPUB over everything', () => {
    expect(pickPreferredFormat(['mobi', 'pdf', 'epub', 'kfx'])).toBe('epub');
  });

  it('falls through the preference tiers', () => {
    expect(pickPreferredFormat(['azw3', 'mobi', 'txt'])).toBe('azw3');
    expect(pickPreferredFormat(['mobi', 'pdf'])).toBe('mobi');
    expect(pickPreferredFormat(['pdf', 'txt'])).toBe('pdf');
    expect(pickPreferredFormat(['txt'])).toBe('txt');
  });

  it('skips formats Readest cannot open', () => {
    expect(pickPreferredFormat(['kfx', 'azw4', 'epub'])).toBe('epub');
    expect(pickPreferredFormat(['kfx', 'docx', 'djvu'])).toBe('');
  });

  it('handles empty and missing lists', () => {
    expect(pickPreferredFormat([])).toBe('');
    expect(pickPreferredFormat(undefined)).toBe('');
    expect(pickPreferredFormat(null)).toBe('');
  });

  it('is case-insensitive on the server format names', () => {
    expect(pickPreferredFormat(['EPUB', 'MOBI'])).toBe('epub');
  });
});

describe('calibre file path', () => {
  it('round-trips server, library and book ids', () => {
    const path = makeCalibreFilePath('srv1', 'Calibre_Library', '42');
    expect(parseCalibreFilePath(path)).toEqual({
      serverId: 'srv1',
      libraryId: 'Calibre_Library',
      bookId: '42',
    });
  });

  it('rejects non-calibre and malformed paths', () => {
    expect(parseCalibreFilePath('/Users/me/book.epub')).toBeNull();
    expect(parseCalibreFilePath(undefined)).toBeNull();
    expect(parseCalibreFilePath('calibre://srv1')).toBeNull();
    expect(parseCalibreFilePath('calibre://srv1/lib/')).toBeNull();
  });
});

describe('computeCalibreServerId', () => {
  it('is stable across trailing slashes and embedded credentials', () => {
    const base = computeCalibreServerId('https://calibre.example.com');
    expect(computeCalibreServerId('https://calibre.example.com/')).toBe(base);
    expect(computeCalibreServerId('https://user:pass@calibre.example.com')).toBe(base);
  });

  it('differs for different servers and path prefixes', () => {
    const a = computeCalibreServerId('https://calibre.example.com');
    expect(computeCalibreServerId('https://other.example.com')).not.toBe(a);
    expect(computeCalibreServerId('https://calibre.example.com/calibre')).not.toBe(a);
  });
});
