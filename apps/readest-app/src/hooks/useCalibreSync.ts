import { useCallback, useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useCalibreServerStore } from '@/store/calibreServerStore';
import { syncAllCalibreServers } from '@/services/calibre/librarySync';
import { eventDispatcher } from '@/utils/event';

const AUTO_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Library-mounted background sync for Calibre servers; mirrors useABSSync. */
export function useCalibreSync() {
  const { appService, envConfig } = useEnv();
  const isSyncingRef = useRef(false);

  // Retry hydration while the store is empty instead of caching the first
  // attempt: `EnvProvider` publishes `appService` BEFORE
  // `appService.loadSettings()` resolves, so this hook's mount-time
  // hydration can read the `{}` placeholder settings and come back with
  // nothing — see useABSSync for the full stranded-sync failure mode.
  const ensureHydrated = useCallback(async () => {
    if (useCalibreServerStore.getState().servers.length > 0) return;
    await useCalibreServerStore.getState().loadCalibreServers();
  }, [envConfig]);

  const checkCalibreServers = useCallback(async () => {
    if (!appService) return;
    if (isSyncingRef.current) return;
    await ensureHydrated();
    if (useCalibreServerStore.getState().getAvailableServers().length === 0) return;

    try {
      isSyncingRef.current = true;
      await syncAllCalibreServers(appService);
    } catch (error) {
      console.error('Calibre sync error:', error);
    } finally {
      isSyncingRef.current = false;
    }
  }, [appService, ensureHydrated]);

  // Auto-trigger on startup once the app service is ready.
  useEffect(() => {
    checkCalibreServers();
  }, [checkCalibreServers]);

  // Listen for explicit sync requests (settings form "Sync now" and after connect).
  useEffect(() => {
    const handler = () => checkCalibreServers();
    eventDispatcher.on('sync-calibre-servers', handler);
    return () => eventDispatcher.off('sync-calibre-servers', handler);
  }, [checkCalibreServers]);

  // Periodic background sync.
  useEffect(() => {
    if (!appService) return;
    const intervalId = setInterval(() => {
      checkCalibreServers();
    }, AUTO_CHECK_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [appService, checkCalibreServers]);

  return { checkCalibreServers };
}
