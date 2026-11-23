import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAndroidRelease } from './app-release';
import { Devices } from './components/Devices';
import { QrReceive, QrSend } from './components/Offline';
import { Pair } from './components/Pair';
import { IncomingPrompt, Transfers } from './components/Transfers';
import { detectLang, I18n, translator, type Lang } from './i18n';
import { store, useStore } from './store';

const REPO = 'https://github.com/justapps-it/Just-share';
type Theme = 'light' | 'dark' | 'auto';

function pref(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* blocked */
  }
}

/** Files shared to the installed web app from another app (share target). */
async function takeShared(): Promise<File[] | null> {
  if (!new URLSearchParams(location.search).has('share')) return null;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('justshare-incoming-share');
    const files: File[] = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (!res) continue;
      files.push(new File([await res.blob()], decodeURIComponent(res.headers.get('x-name') ?? 'file'), { type: res.headers.get('content-type') ?? '' }));
      await cache.delete(req);
    }
    return files.length ? files : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [lang, setLangState] = useState<Lang>(detectLang);
  const t = useMemo(() => translator(lang), [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    savePref('justshare-lang', l);
  }, []);
  const [theme, setTheme] = useState<Theme>(() => pref('justshare-theme', 'auto') as Theme);
  const st = useStore();
  const android = useAndroidRelease();
  const [qr, setQr] = useState<'send' | 'receive' | null>(null);
  const [pending, setPending] = useState<File[] | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    savePref('justshare-theme', theme);
  }, [theme]);
  useEffect(() => {
    store.start();
    void takeShared().then((f) => f && setPending(f));
  }, []);

  const toggleTheme = () => {
    const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    setTheme(dark ? 'light' : 'dark');
  };

  return (
    <I18n.Provider value={{ lang, t, setLang }}>
      <div className="app">
        <header className="top">
          <a className="brand" href="/">
            <img src="/favicon.svg?v=1" alt="" width="32" height="32" />
            <span>JustShare</span>
          </a>
          <nav className="top-actions">
            {android && (
              <a className="app-pill" href="#android">
                <AndroidLogo size={16} />
                <span>{t('appBadge')}</span>
              </a>
            )}
            <a className="nav-link hide-sm" href="https://www.justapps.it">
              JustApps
            </a>
            <button className="icon-btn" onClick={() => setLang(lang === 'it' ? 'en' : 'it')} aria-label={t('language')} title={t('language')}>
              <span className="lang">{lang === 'it' ? 'EN' : 'IT'}</span>
            </button>
            <button className="icon-btn" onClick={toggleTheme} aria-label={t('theme')} title={t('theme')}>
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" fill="currentColor" />
              </svg>
            </button>
            <a className="icon-btn" href={REPO} target="_blank" rel="noreferrer" aria-label="GitHub" title="GitHub">
              <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                />
              </svg>
            </a>
          </nav>
        </header>

        <main>
          <section className="hero">
            <h1>
              {t('heroA')}
              <br />
              <span>{t('heroB')}</span>
            </h1>
            <p className="lead">{t('lead')}</p>
            <div className="me">
              <span className="muted">{t('you')}</span>
              {editing ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = new FormData(e.currentTarget).get('name') as string;
                    store.rename(v);
                    setEditing(false);
                  }}
                >
                  <input name="name" className="name-input" defaultValue={st.me.name} autoFocus maxLength={40} onBlur={(e) => (store.rename(e.target.value), setEditing(false))} />
                </form>
              ) : (
                <button className="me-name" onClick={() => setEditing(true)} title={t('rename')}>
                  {st.me.name} <span aria-hidden="true">✎</span>
                </button>
              )}
            </div>
          </section>

          <Devices pending={pending} onSent={() => setPending(null)} />
          <Transfers />

          <div className="two">
            <Pair />
            <section className="card offline">
              <h2>{t('offlineTitle')}</h2>
              <p className="muted">{t('offlineText')}</p>
              <div className="row wrap">
                <button className="btn primary" onClick={() => setQr('send')}>
                  {t('qrSend')}
                </button>
                <button className="btn" onClick={() => setQr('receive')}>
                  {t('qrReceive')}
                </button>
              </div>
            </section>
          </div>

          {android && (
            <section className="android" id="android">
              <div className="android-card">
                <img className="android-icon" src="/icons/icon-192.png?v=1" alt="" width="96" height="96" />
                <div className="android-body">
                  <span className="android-badge">
                    {t('appBadge')} · v{android.version}
                  </span>
                  <h2>{t('appTitle')}</h2>
                  <p>{t('appText')}</p>
                </div>
                <div className="android-cta">
                  <a className="btn android-download" href={android.url} rel="noopener">
                    <AndroidLogo size={22} />
                    {t('appDownload')}
                    <small>{android.sizeMB} MB</small>
                  </a>
                  <p className="android-install">{t('appInstall')}</p>
                  <p className="android-hash" title={`SHA-256 ${android.sha256}`}>
                    <a href={android.releases} target="_blank" rel="noreferrer">
                      GitHub Releases
                    </a>
                    {android.sha256 ? ` · SHA-256 ${android.sha256.slice(0, 12)}…` : ''}
                  </p>
                </div>
              </div>
            </section>
          )}

          <section className="how">
            <ol>
              {(['1', '2', '3'] as const).map((n) => (
                <li key={n}>
                  <span className="num">{n}</span>
                  <h3>{t(`how${n}t`)}</h3>
                  <p>{t(`how${n}`)}</p>
                </li>
              ))}
            </ol>
            <p className="privacy">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z" fill="currentColor" />
              </svg>
              {t('privacy')}
            </p>
          </section>
        </main>

        <footer className="foot">
          <p>
            {t('madeBy')} <a href="https://www.justapps.it">JustApps</a> · {t('openSource')},{' '}
            <a href={REPO} target="_blank" rel="noreferrer">
              {t('license')}
            </a>
          </p>
          <p>WebRTC · libsodium · ZXing · WebAssembly</p>
        </footer>

        <IncomingPrompt />
        {qr === 'send' && <QrSend initialFiles={pending ?? undefined} onClose={() => setQr(null)} />}
        {qr === 'receive' && <QrReceive onClose={() => setQr(null)} />}
      </div>
    </I18n.Provider>
  );
}

function AndroidLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M17.6 9.48l1.84-3.18a.38.38 0 00-.66-.38l-1.86 3.22a11.4 11.4 0 00-9.84 0L5.22 5.92a.38.38 0 00-.66.38L6.4 9.48A10.8 10.8 0 001 18h22a10.8 10.8 0 00-5.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z"
      />
    </svg>
  );
}
