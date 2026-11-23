import { useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { store, useStore, type Device } from '../store';

export function DeviceIcon({ type }: { type: string }) {
  if (type === 'desktop')
    return (
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    );
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x={type === 'tablet' ? 4 : 7} y="2" width={type === 'tablet' ? 16 : 10} height="20" rx="2.5" />
      <path d="M11 18h2" />
    </svg>
  );
}

export function Devices({ pending, onSent }: { pending: File[] | null; onSent(): void }) {
  const { t } = useI18n();
  const st = useStore();
  const [target, setTarget] = useState<Device | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const sendNow = (d: Device, files: File[], text?: string) => {
    void store.send(d.id, files, text);
    onSent();
  };

  return (
    <section className="devices-section">
      <div className="section-head">
        <h2>{t('nearby')}</h2>
        <span className={`dot ${st.online ? 'on' : ''}`} />
        <span className="muted small">{st.online ? t('online') : t('offlineNet')}</span>
      </div>
      {pending && <p className="hint">{t('sharedIn')}</p>}
      <ul className="devices">
        {st.devices.map((d) => (
          <li key={d.id}>
            <button
              className={`device ${over === d.id ? 'over' : ''}`}
              onClick={() => (pending ? sendNow(d, pending) : setTarget(d))}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(d.id);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const files = Array.from(e.dataTransfer.files);
                if (files.length) sendNow(d, files);
              }}
            >
              <DeviceIcon type={d.device} />
              <span className="device-name">{d.name}</span>
              <span className="device-via">{d.via.includes('code') ? t('paired') : t('sameNet')}</span>
            </button>
          </li>
        ))}
        {!st.devices.length && (
          <li className="radar-wrap">
            <div className="radar" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p className="muted">{t('nearbyEmpty')}</p>
          </li>
        )}
      </ul>
      {st.devices.length > 0 && !pending && <p className="small muted">{t('dropHere')}</p>}
      {target && <SendSheet device={target} onClose={() => setTarget(null)} onSend={(f, txt) => sendNow(target, f, txt)} />}
    </section>
  );
}

function SendSheet({ device, onClose, onSend }: { device: Device; onClose(): void; onSend(files: File[], text?: string): void }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const pick = (input: HTMLInputElement | null) => {
    const list = Array.from(input?.files ?? []);
    if (list.length) {
      onSend(list);
      onClose();
    }
  };
  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card sheet">
        <div className="sheet-head">
          <DeviceIcon type={device.device} />
          <div>
            <span className="muted small">{t('sendTo')}</span>
            <h2>{device.name}</h2>
          </div>
        </div>
        <div className="row">
          <button className="btn primary big grow" onClick={() => files.current?.click()}>
            {t('chooseFiles')}
          </button>
          <button className="btn big" onClick={() => folder.current?.click()}>
            {t('chooseFolder')}
          </button>
        </div>
        <input ref={files} type="file" multiple hidden onChange={(e) => pick(e.target)} />
        <input ref={folder} type="file" multiple hidden {...({ webkitdirectory: '' } as object)} onChange={(e) => pick(e.target)} />
        <textarea className="text-input" rows={3} placeholder={t('textPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row end">
          <button className="btn ghost" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn accent"
            disabled={!text.trim()}
            onClick={() => {
              onSend([], text.trim());
              onClose();
            }}
          >
            {t('sendText')}
          </button>
        </div>
      </div>
    </div>
  );
}
