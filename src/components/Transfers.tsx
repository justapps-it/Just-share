import { formatBytes, useI18n, type Key } from '../i18n';
import { store, useStore, type Transfer } from '../store';
import { TextBox } from './Offline';
import { ReceivedList } from './Received';

function route(t: (k: Key) => string, r: Transfer['route']) {
  if (r === 'direct') return t('routeDirect');
  if (r === 'internet') return t('routeInternet');
  if (r === 'relay') return t('routeRelay');
  return '';
}

export function IncomingPrompt() {
  const { t, lang } = useI18n();
  const st = useStore();
  const ask = st.transfers.find((x) => x.status === 'asking');
  if (!ask) return null;
  return (
    <div className="modal" role="alertdialog" aria-modal="true">
      <div className="modal-card sheet incoming">
        <h2>
          {ask.peerName} <span className="muted">{ask.files.length ? t('incoming') : t('incomingText')}</span>
        </h2>
        {ask.files.length > 0 && (
          <p>
            {ask.files.length === 1 ? ask.files[0].name : `${ask.files.length} ${t('files')}`} · {formatBytes(ask.total, lang)}
          </p>
        )}
        {ask.sas && (
          <div className="sas">
            <span className="muted small">{t('verify')}</span>
            <b>{ask.sas}</b>
            <span className="muted small">{t('verifyHelp')}</span>
          </div>
        )}
        <div className="row end">
          <button className="btn" onClick={() => void store.respond(ask.id, false)}>
            {t('decline')}
          </button>
          <button className="btn accent big" onClick={() => void store.respond(ask.id, true)}>
            {t('accept')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Transfers() {
  const { t, lang } = useI18n();
  const st = useStore();
  if (!st.transfers.length) return null;
  return (
    <section className="transfers">
      <div className="section-head">
        <h2>{t('transfers')}</h2>
        <button className="btn small ghost" onClick={() => store.clearFinished()}>
          {t('clear')}
        </button>
      </div>
      <ul>
        {st.transfers.map((x) => {
          const active = ['connecting', 'waiting', 'sending', 'receiving'].includes(x.status);
          const pct = x.total ? Math.round((x.done / x.total) * 100) : x.status === 'done' ? 100 : 0;
          const label =
            x.status === 'waiting'
              ? `${t('waiting')} ${x.peerName}`
              : x.status === 'error'
                ? `${t('error')}: ${x.error && x.error in { checksum: 1, connection_failed: 1, connection_closed: 1, connect_timeout: 1 } ? t(x.error as Key) : x.error}`
                : t(x.status as Key);
          return (
            <li key={x.id} className={`transfer ${x.status}`}>
              <div className="transfer-top">
                <span className="dir">{x.direction === 'out' ? '↑' : '↓'}</span>
                <div className="grow">
                  <b>{x.peerName}</b>
                  <span className="muted small">
                    {' '}
                    · {x.files.length ? `${x.files.length === 1 ? x.files[0].name : `${x.files.length} ${t('files')}`} · ${formatBytes(x.total, lang)}` : 'text'}
                  </span>
                  <div className="small muted">
                    {label}
                    {active && x.speed > 0 ? ` · ${formatBytes(x.speed, lang)}/s` : ''}
                    {x.route ? ` · ${route(t, x.route)}` : ''}
                  </div>
                  {x.sas && (x.status === 'waiting' || x.status === 'sending' || x.status === 'receiving') && (
                    <div className="sas-inline">
                      {t('verify')} <b>{x.sas}</b>
                    </div>
                  )}
                </div>
                {active && (
                  <button className="icon-btn" onClick={() => store.cancel(x.id)} aria-label={t('cancel')}>
                    ✕
                  </button>
                )}
              </div>
              {active && x.total > 0 && (
                <div className="progress">
                  <div className={`bar ${x.status === 'connecting' || x.status === 'waiting' ? 'indeterminate' : ''}`} style={{ width: x.status === 'connecting' || x.status === 'waiting' ? undefined : `${pct}%` }} />
                </div>
              )}
              {x.direction === 'in' && x.text && x.status !== 'asking' && x.status !== 'declined' && <TextBox text={x.text} />}
              {x.direction === 'in' && x.received.length > 0 && <ReceivedList files={x.received} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
