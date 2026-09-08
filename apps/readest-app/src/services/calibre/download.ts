import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type { ProgressHandler } from '@/utils/transfer';
import { createCalibreClient } from '@/services/calibre/client';
import { READEST_OPDS_USER_AGENT } from '@/services/constants';
import { downloadFile } from '@/libs/storage';
import { needsProxy, probeAuth } from '@/app/opds/utils/opdsReq';
import { resolveCalibreIdentity } from '@/utils/calibre';
import { getLocalBookFilename } from '@/utils/book';
import { uniqueId } from '@/utils/misc';
import { findCalibreServerById } from '@/store/calibreServerStore';

interface DownloadCalibreBookOptions {
  onProgress?: ProgressHandler;
  /** Pick a specific format instead of the row's preferred one (lowercase ext). */
  format?: string;
}

/**
 * Download a Calibre book's file into its managed shelf directory
 * (`Books/<hash>/<title>.<ext>`) so the SAME library row that carried the
 * sync stub becomes the readable book: hash, progress, notes, and config
 * keys all stay stable, and `resolveBookContentSource` finds a managed file
 * on the next open without any re-import or stub-replacement dance.
 *
 * On success the synthetic `calibre://` filePath is cleared: the row then
 * looks like a normal local book (its file syncs to Readest Cloud, removing
 * the server no longer touches it, reconcile stops treating it as a stub),
 * while `metadata.calibreSource` stays as the identity anchor for
 * re-download and progress sync. Works for both stubs and previously
 * downloaded copies whose local file was deleted (identity via calibreSource).
 *
 * Returns true when the file is on disk (newly downloaded or already there).
 */
export const downloadCalibreBook = async (
  appService: AppService,
  book: Book,
  options: DownloadCalibreBookOptions = {},
): Promise<boolean> => {
  if (await appService.exists(getLocalBookFilename(book), 'Books')) {
    book.downloadedAt = book.downloadedAt ?? Date.now();
    book.filePath = undefined;
    return true;
  }
  const identity = resolveCalibreIdentity(book);
  if (!identity) return false;
  const server = findCalibreServerById(identity.serverId);
  if (!server || server.deletedAt) return false;
  const format = (options.format ?? book.metadata?.calibreSource?.format ?? '').toLowerCase();
  if (!format) return false;

  const client = createCalibreClient(server);
  const url = client.buildDownloadUrl(identity.libraryId, identity.bookId, format);
  const headers: Record<string, string> = {
    'User-Agent': READEST_OPDS_USER_AGENT,
    Accept: '*/*',
  };
  if (server.username && server.password) {
    // probeAuth answers the challenge for THIS exact url; a Digest header is
    // bound to its request uri, so it must be minted per download target.
    const auth = await probeAuth(url, server.username, server.password, needsProxy(url));
    if (auth) headers['Authorization'] = auth;
  }

  // Land in Cache first, then copy into the managed shelf dir: the transfer
  // manager writes wherever resolveFilePath points on every platform, but the
  // web filesystem only accepts base-relative targets through copyFile.
  const dstTmp = await appService.resolveFilePath(`calibre_${uniqueId()}.${format}`, 'Cache');
  try {
    await downloadFile({
      appService,
      dst: dstTmp,
      cfp: '',
      url,
      headers,
      singleThreaded: true,
      skipSslVerification: true,
      onProgress: options.onProgress,
    });
    await appService.copyFile(dstTmp, 'None', getLocalBookFilename(book), 'Books');
    book.downloadedAt = Date.now();
    // The calibre:// path is an identity for a fileless stub; once the real
    // file is in the managed shelf dir it would only misroute availability
    // checks, cloud sync, and reconcile. calibreSource keeps the identity.
    book.filePath = undefined;
    return true;
  } finally {
    try {
      await appService.deleteFile(dstTmp, 'None');
    } catch {
      // best effort cleanup
    }
  }
};
