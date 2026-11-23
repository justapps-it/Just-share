import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { scanCamera } from '../lib/camera';
import { useI18n } from '../i18n';
import { store, useStore } from '../store';

export function Pair() {
  const { t } = useI18n();
  const st = useStore();
  const [mode, setMode] = useState<'none' | 'enter' | 'scan'>('none');
  const [code, setCode] = useState('');
  const qr = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const pairedCount = st.devices.filter((d) => d.via.includes('code')).length;

  useEffect(() => {
    if (st.code && qr.current) {
      void QRCode.toCanvas(qr.current, `${location.origin}/#c=${st.code}`, { width: 200, margin: 1, errorCorrectionLevel: 'M' });
    }
  }, [st.code]);

  useEffect(() => {
    if (mode !== 'scan') return;
    let stop: (() => void) | undefined;
    void scanCamera(video.current!, (bytes) => {
      const m = new TextDecoder().decode(bytes).match(/#c=(\d{6})|^(\d{6})$/);
      const c = m?.[1] ?? m?.[2];
      if (c) {
        stop?.();
        store.joinCode(c);
        setMode('none');
      }
    })
      .then((s) => (stop = s))
      .catch(() => setMode('none'));
    return () => stop?.();
  }, [mode]);

  return (
    <section className="card pair">
      <h2>{t('farTitle')}</h2>
      <p className="muted">{t('farText')}</p>
      {st.code ? (
        <div className="code-box">
          <canvas ref={qr} className="qr" />
          <div>
            <span className="muted small">{t('yourCode')}</span>
            <div className="code">
              {st.code.slice(0, 3)} {st.code.slice(3)}
            </div>
            <p className="small muted">{t('codeHelp')}</p>
            <p className="small">{pairedCount ? `✓ ${pairedCount} ${t('paired')}` : t('waitingPeer')}</p>
            <button className="btn small" onClick={() => store.leaveCode()}>
              {t('closeCode')}
            </button>
          </div>
        </div>
      ) : mode === 'enter' ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^\d{6}$/.test(code)) {
              store.joinCode(code);
              setMode('none');
            }
          }}
        >
          <input
            className="code-input"
            inputMode="numeric"
            autoFocus
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <button className="btn primary" disabled={code.length !== 6}>
            {t('join')}
          </button>
          <button type="button" className="btn ghost" onClick={() => setMode('none')}>
            {t('cancel')}
          </button>
        </form>
      ) : mode === 'scan' ? (
        <div>
          <div className="camera small-cam">
            <video ref={video} playsInline muted />
            <div className="camera-frame" />
          </div>
          <button className="btn ghost" onClick={() => setMode('none')}>
            {t('cancel')}
          </button>
        </div>
      ) : (
        <div className="row wrap">
          <button className="btn primary" onClick={() => store.newCode()}>
            {t('showCode')}
          </button>
          <button className="btn" onClick={() => setMode('enter')}>
            {t('enterCode')}
          </button>
          <button className="btn" onClick={() => setMode('scan')}>
            {t('scanQr')}
          </button>
        </div>
      )}
    </section>
  );
}
