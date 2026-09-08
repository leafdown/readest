import clsx from 'clsx';
import React, { useEffect, useState } from 'react';
import { MdCloudSync } from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { type EnvConfigType } from '@/services/environment';
import { useTranslation } from '@/hooks/useTranslation';
import { useCalibreServerStore } from '@/store/calibreServerStore';
import { CalibreClient, createCalibreClient } from '@/services/calibre/client';
import { removeCalibreServerBooks } from '@/services/calibre/librarySync';
import { computeCalibreServerId } from '@/utils/calibre';
import { eventDispatcher } from '@/utils/event';
import type { CalibreLibraryInfo, CalibreServer } from '@/types/calibre';
import type { AppService } from '@/types/system';
import SubPageHeader from '../SubPageHeader';
import { BoxedList, NavigationRow, SectionTitle, SettingsSwitchRow, Tips } from '../primitives';

interface CalibreFormProps {
  onBack: () => void;
}

const normalizeCalibreUrl = (url: string): string => url.trim().replace(/\/+$/, '');

const isValidCalibreUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * Calibre content-server integration sub-page. Mirrors ABSForm: multiple
 * servers in a boxed list, each with a management view (rename, library
 * picker, sync now, remove). Unlike ABS, authentication is optional — an
 * unauthenticated calibre-server (`--enable-auth` off) is fully supported.
 */
const CalibreForm: React.FC<CalibreFormProps> = ({ onBack }) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const servers = useCalibreServerStore((state) => state.servers).filter((s) => !s.deletedAt);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);

  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  const activeServer = servers.find((server) => server.id === activeServerId);

  const handleConnect = async () => {
    const trimmedUrl = normalizeCalibreUrl(url);
    if (!isValidCalibreUrl(trimmedUrl)) {
      setConnectError(_('Server URL must start with http:// or https://'));
      return;
    }

    setIsConnecting(true);
    setConnectError('');

    // id === URL-derived id (see calibreServerStore.addServer): the id ends up
    // inside every synced stub's filePath and hash, so it must be URL-derived,
    // never a local timestamp.
    const draft = {
      name: trimmedUrl.replace(/^https?:\/\//i, ''),
      url: trimmedUrl,
      username: username || undefined,
      password: password || undefined,
    };
    const probe = { id: computeCalibreServerId(trimmedUrl), ...draft } as CalibreServer;

    try {
      const client = new CalibreClient(probe);
      const info: CalibreLibraryInfo = await client.getLibraryInfo();
      const added = useCalibreServerStore.getState().addServer({
        ...draft,
        libraryId: info.defaultLibraryId,
        libraryName: info.libraries.find((l) => l.id === info.defaultLibraryId)?.name,
      });
      void useCalibreServerStore.getState().saveCalibreServers(envConfig);
      void eventDispatcher.dispatch('sync-calibre-servers', {});

      setUrl('');
      setUsername('');
      setActiveServerId(added.id);
    } catch {
      setConnectError(_('Failed to connect to the Calibre server. Check the URL and credentials.'));
    } finally {
      setIsConnecting(false);
      setPassword('');
    }
  };

  return (
    <div className='w-full'>
      <SubPageHeader
        parentLabel={_('Integrations')}
        currentLabel={_('Calibre')}
        description={_('Sync books from your Calibre content server into your library.')}
        onBack={onBack}
      />

      {activeServer ? (
        <CalibreServerDetail
          server={activeServer}
          envConfig={envConfig}
          appService={appService}
          onBack={() => setActiveServerId(null)}
          onRemoved={() => setActiveServerId(null)}
        />
      ) : (
        <div className='space-y-5'>
          {servers.length > 0 && (
            <BoxedList title={_('Servers')}>
              {servers.map((server) => (
                <NavigationRow
                  key={server.id}
                  title={server.name}
                  status={server.lastSyncedAt ? _('Synced') : _('Not connected')}
                  onClick={() => setActiveServerId(server.id)}
                />
              ))}
            </BoxedList>
          )}

          <div className='space-y-4'>
            <SectionTitle>
              {servers.length > 0 ? _('Add Another Server') : _('Add Server')}
            </SectionTitle>
            <form
              className='space-y-4'
              onSubmit={(e) => {
                e.preventDefault();
                handleConnect();
              }}
            >
              <div className='space-y-1.5'>
                <SectionTitle as='label' htmlFor='calibre-server-url' className='block'>
                  {_('Server URL')}
                </SectionTitle>
                <input
                  id='calibre-server-url'
                  type='text'
                  placeholder='https://calibre.example.com'
                  className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
                  spellCheck='false'
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setConnectError('');
                  }}
                />
              </div>

              <div className='space-y-1.5'>
                <SectionTitle as='label' htmlFor='calibre-username' className='block'>
                  {_('Username')}
                </SectionTitle>
                <input
                  id='calibre-username'
                  type='text'
                  placeholder={_('Leave empty for anonymous access')}
                  className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
                  spellCheck='false'
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete='username'
                />
              </div>

              <div className='space-y-1.5'>
                <SectionTitle as='label' htmlFor='calibre-password' className='block'>
                  {_('Password')}
                </SectionTitle>
                <input
                  id='calibre-password'
                  type='password'
                  placeholder={_('Your Password')}
                  className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete='current-password'
                />
              </div>

              {connectError && <p className='text-error px-0.5 text-[0.85em]'>{connectError}</p>}

              <div className='flex justify-end pt-1'>
                <button
                  type='submit'
                  disabled={isConnecting || !url}
                  className={clsx(
                    'btn btn-contrast',
                    'h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
                    'focus-visible:ring-base-content/40 focus-visible:outline-hidden focus-visible:ring-2',
                    isConnecting && 'opacity-60',
                  )}
                >
                  {isConnecting ? (
                    <span className='loading loading-spinner loading-sm' />
                  ) : (
                    _('Connect')
                  )}
                </button>
              </div>
            </form>
            <Tips>
              <li>
                {_(
                  'Point this at a calibre content server (calibre-server) URL. Reading positions sync back when you connect as a logged-in user.',
                )}
              </li>
            </Tips>
          </div>
        </div>
      )}
    </div>
  );
};

interface CalibreServerDetailProps {
  server: CalibreServer;
  envConfig: EnvConfigType;
  appService: AppService | null;
  onBack: () => void;
  onRemoved: () => void;
}

const CalibreServerDetail: React.FC<CalibreServerDetailProps> = ({
  server,
  envConfig,
  appService,
  onBack,
  onRemoved,
}) => {
  const _ = useTranslation();
  const [name, setName] = useState(server.name);
  const [libraries, setLibraries] = useState<CalibreLibraryInfo | null>(null);
  const [libError, setLibError] = useState('');
  const [isRemoving, setIsRemoving] = useState(false);

  useEffect(() => {
    setName(server.name);
  }, [server.id, server.name]);

  // Re-fetch the library list only when switching to a different server —
  // a library switch or name edit must not restart this fetch.
  useEffect(() => {
    let cancelled = false;
    setLibraries(null);
    setLibError('');
    const client = createCalibreClient(server);
    client
      .getLibraryInfo()
      .then((info) => {
        if (!cancelled) setLibraries(info);
      })
      .catch(() => {
        if (!cancelled) setLibError(_('Failed to load libraries from the server.'));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const persist = () => {
    void useCalibreServerStore.getState().saveCalibreServers(envConfig);
  };

  const handleNameBlur = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(server.name);
      return;
    }
    if (trimmed === server.name) return;
    useCalibreServerStore.getState().updateServer(server.id, { name: trimmed });
    persist();
  };

  const handleSelectLibrary = (libraryId: string) => {
    if (!libraries) return;
    if (libraryId === server.libraryId) return;
    const libraryName = libraries.libraries.find((l) => l.id === libraryId)?.name;
    useCalibreServerStore.getState().updateServer(server.id, { libraryId, libraryName });
    persist();
    // Books of the previous library are tombstoned by the reconcile pass
    // (they are no longer in the seen set), so a plain re-sync switches shelves.
    void eventDispatcher.dispatch('sync-calibre-servers', {});
  };

  const handleSyncNow = () => {
    void eventDispatcher.dispatch('sync-calibre-servers', {});
  };

  const handleRemove = async () => {
    setIsRemoving(true);
    useCalibreServerStore.getState().removeServer(server.id);
    persist();
    if (appService) {
      await removeCalibreServerBooks(appService, server.id);
    }
    setIsRemoving(false);
    onRemoved();
  };

  return (
    <div className='space-y-5'>
      <button
        type='button'
        onClick={onBack}
        className='text-base-content/70 hover:text-primary -mt-2 px-4 text-[0.85em] transition-colors duration-150 focus-visible:underline focus-visible:outline-hidden'
      >
        {_('All Servers')}
      </button>

      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='calibre-server-name' className='block'>
          {_('Name')}
        </SectionTitle>
        <input
          id='calibre-server-name'
          type='text'
          className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleNameBlur}
        />
      </div>

      <div className='space-y-1.5'>
        <SectionTitle as='label' className='block'>
          {_('Server URL')}
        </SectionTitle>
        <input
          type='text'
          disabled
          className='input eink-bordered h-11 w-full text-sm opacity-70'
          value={server.url}
        />
      </div>

      <div className='space-y-0.5 px-4'>
        <p className='text-base-content/65 text-[0.85em]'>
          {server.username
            ? _('Connected as {{username}}', { username: server.username })
            : _('Anonymous access')}
        </p>
        <p className='text-base-content/65 text-[0.85em]'>
          {server.lastSyncedAt
            ? _('Last synced {{time}}', { time: new Date(server.lastSyncedAt).toLocaleString() })
            : _('Never synced')}
        </p>
      </div>

      <div className='space-y-2'>
        <SectionTitle>{_('Library to Sync')}</SectionTitle>
        {libError ? (
          <p className='text-error px-4 text-[0.85em]'>{libError}</p>
        ) : libraries === null ? (
          <div className='flex justify-center py-4'>
            <span className='loading loading-spinner loading-sm' />
          </div>
        ) : libraries.libraries.length === 0 ? (
          <p className='text-base-content/65 px-4 text-[0.85em]'>
            {_('No libraries found on this server.')}
          </p>
        ) : (
          <BoxedList>
            {libraries.libraries.map((library) => (
              <SettingsSwitchRow
                key={library.id}
                label={library.name}
                checked={(server.libraryId ?? libraries.defaultLibraryId) === library.id}
                onChange={() => handleSelectLibrary(library.id)}
              />
            ))}
          </BoxedList>
        )}
      </div>

      <div className='flex items-center justify-between gap-3 pt-1'>
        <button
          type='button'
          onClick={handleSyncNow}
          className='btn btn-ghost btn-sm h-9 min-h-9 gap-1.5'
        >
          <MdCloudSync className='h-4 w-4' />
          {_('Sync Now')}
        </button>
        <button
          type='button'
          onClick={handleRemove}
          disabled={isRemoving}
          className={clsx(
            'eink-bordered',
            'h-9 rounded-lg px-4 text-sm font-medium',
            'text-error hover:bg-error/10',
            'transition-colors duration-150',
            'focus-visible:ring-error/40 focus-visible:outline-hidden focus-visible:ring-2',
            isRemoving && 'opacity-60',
          )}
        >
          {_('Remove Server')}
        </button>
      </div>
    </div>
  );
};

export default CalibreForm;
