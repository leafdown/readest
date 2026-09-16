import { FileSystem, SaveLibraryBooksOptions } from '@/types/system';
import { Book } from '@/types/book';
import { getLibraryFilename } from '@/utils/book';
import { safeLoadJSON, safeSaveJSON } from './persistence';

const COVER_CONCURRENCY = 20;

/**
 * The mtime+size of library.json as of THIS window's last write. While the
 * file on disk still matches it, the merge-floor reload below can be
 * skipped: reloading and parsing the whole file before every save (a 15k
 * book library runs tens of MB) dominated large-library sync saves. Any
 * other window's write changes mtime/size and restores the defensive
 * reload, so multi-window correctness is kept.
 */
let lastLibraryWrite: { mtimeMs: number; size: number } | null = null;

const diskMatchesLastWrite = async (fs: FileSystem, libraryFile: string): Promise<boolean> => {
  if (!lastLibraryWrite) return false;
  try {
    const info = await fs.stats(libraryFile, 'Books');
    return (
      !!info?.mtime &&
      info.mtime.getTime() === lastLibraryWrite.mtimeMs &&
      info.size === lastLibraryWrite.size
    );
  } catch {
    return false;
  }
};

const recordLibraryWrite = async (fs: FileSystem, libraryFile: string): Promise<void> => {
  try {
    const info = await fs.stats(libraryFile, 'Books');
    lastLibraryWrite = info?.mtime ? { mtimeMs: info.mtime.getTime(), size: info.size } : null;
  } catch {
    lastLibraryWrite = null;
  }
};

async function processInBatches<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
  }
}

export async function loadLibraryBooks(
  fs: FileSystem,
  generateCoverImageUrl: (book: Book) => Promise<string>,
): Promise<Book[]> {
  const libraryFilename = getLibraryFilename();

  if (!(await fs.exists('', 'Books'))) {
    await fs.createDir('', 'Books', true);
  }

  const books = await safeLoadJSON<Book[]>(fs, libraryFilename, 'Books', []);

  await processInBatches(books, COVER_CONCURRENCY, async (book) => {
    book.coverImageUrl = await generateCoverImageUrl(book);
    book.updatedAt ??= book.lastUpdated || Date.now();
  });

  return books;
}

export async function saveLibraryBooks(
  fs: FileSystem,
  books: Book[],
  options?: SaveLibraryBooksOptions,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const incoming = books.map(({ coverImageUrl, ...rest }) => rest);
  const libraryFile = getLibraryFilename();

  if (options?.replace) {
    await safeSaveJSON(fs, libraryFile, 'Books', incoming);
    await recordLibraryWrite(fs, libraryFile);
    return;
  }

  // Merge-floor: treat the on-disk library as a floor. A routine save may add
  // new books or modify existing rows (including setting `deletedAt`
  // tombstones), but it must never silently drop a book that exists on disk.
  // This stops a stale or partially-loaded in-memory library (e.g. the
  // cold-start "Open with" race) from wiping library.json. Deliberate removals
  // must go through `{ replace: true }`.
  //
  // The reload is skipped while the file still matches this window's last
  // write — the floor is then provably the data we just wrote (see
  // lastLibraryWrite), and re-reading tens of MB per save is pure overhead.
  if (!(await diskMatchesLastWrite(fs, libraryFile))) {
    const existing = await safeLoadJSON<Book[]>(fs, getLibraryFilename(), 'Books', []);
    const merged = new Map<string, Book>();
    for (const book of existing) merged.set(book.hash, book);
    for (const book of incoming) merged.set(book.hash, book); // incoming wins per hash
    await safeSaveJSON(fs, libraryFile, 'Books', Array.from(merged.values()));
  } else {
    await safeSaveJSON(fs, libraryFile, 'Books', incoming);
  }
  await recordLibraryWrite(fs, libraryFile);
}
