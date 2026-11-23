import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { scanCamera } from '../lib/camera';
import { FountainDecoder, FountainEncoder, HEADER } from '../lib/fountain';
import { pack, unpack, type Unpacked } from '../lib/packet';
import { formatBytes, useI18n } from '../i18n';
import { ReceivedList } from './Received';

const SPEEDS = {
  slow: { block: 380, fps: 8 },
  normal: { block: 620, fps: 10 },
  fast: { block: 900, fps: 12 },
} as const;
type Speed = keyof typeof SPEEDS;

export function QrSend({ initialFiles, onClose }: { initialFiles?: File[]; onClose(): void }) {
  const { t, lang } = useI18n();
  const [files, setFiles] = useState<File[]>(initialFiles ?? []);
  const [text, setText] = useState('');
  const [payload, setPayload] = useState<Uint8Array | null>(null);
  const [speed, setSpeed] = useState<Speed>('normal');
  const [frame, setFrame] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);

  const start = async () => setPayload(await pack(files, text.trim()));

  useEffect(() => {
    if (!payload || !canvas.current) return;
    const { block, fps } = SPEEDS[speed];
    const enc = new FountainEncoder(payload, block);
    const c = canvas.current;
    let seq = 0;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      const data = enc.frame(seq);
      await QRCode.toCanvas(c, [{ data, mode: 'byte' }], { errorCorrectionLevel: 'L', margin: 3, width: Math.min(900, c.parentElement!.clientWidth), color: { dark: '#000000', light: '#ffffff' } });
      setFrame(seq);
      seq++;
      busy = false;
    }, 1000 / fps);
    return () => clearInterval(timer);
  }, [payload, speed]);

  const size = files.reduce((n, f) => n + f.size, 0) + text.length;
  const est = (n: number) => {
    const { block, fps } = SPEEDS[speed];
    const s = Math.ceil(((n / block) * 1.4) / fps);
    return s < 60 ? `${s} s` : `${Math.ceil(s / 60)} min`;
  };

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal-card qr-card">
        <div className="modal-head">
          <h2>{t('qrSend')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('close')}>
            ✕
          </button>
        </div>
        {!payload ? (
          <>
            <p className="muted">{t('qrPick')}</p>
            <label className="btn">
              {t('chooseFiles')}
              <input type="file" multiple hidden onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
            </label>
            {files.length > 0 && <p className="small">{files.map((f) => `${f.name} (${formatBytes(f.size, lang)})`).join(', ')}</p>}
            <textarea className="text-input" rows={3} placeholder={t('textPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row wrap">
              <span className="small muted">{t('qrSpeed')}:</span>
              {(['slow', 'normal', 'fast'] as const).map((s) => (
                <button key={s} className={`chip ${speed === s ? 'on' : ''}`} onClick={() => setSpeed(s)}>
                  {s === 'slow' ? t('qrSlow') : s === 'fast' ? t('qrFast') : '•'}
                </button>
              ))}
            </div>
            {size > 200_000 && (
              <p className="small warn">
                {t('qrBig')} {est(size)}.
              </p>
            )}
            <button className="btn primary big" disabled={!files.length && !text.trim()} onClick={start}>
              {t('qrStart')}
            </button>
          </>
        ) : (
          <>
            <div className="qr-stage">
              <canvas ref={canvas} />
            </div>
            <p className="small muted">{t('qrHelp')}</p>
            <p className="mono small">
              {formatBytes(payload.length, lang)} · {Math.ceil(payload.length / SPEEDS[speed].block)} blocks · {t('qrFrame')} {frame + 1} · ~{est(payload.length)}
            </p>
            <div className="row wrap">
              {(['slow', 'normal', 'fast'] as const).map((s) => (
                <button key={s} className={`chip ${speed === s ? 'on' : ''}`} onClick={() => setSpeed(s)}>
                  {s === 'slow' ? t('qrSlow') : s === 'fast' ? t('qrFast') : '•'}
                </button>
              ))}
              <button className="btn" onClick={() => setPayload(null)}>
                {t('stop')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function QrReceive({ onClose }: { onClose(): void }) {
  const { t, lang } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [progress, setProgress] = useState(0);
  const [info, setInfo] = useState<{ size: number; frames: number } | null>(null);
  const [result, setResult] = useState<Unpacked | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    const dec = new FountainDecoder();
    let finished = false;
    (async () => {
      try {
        stop = await scanCamera(video.current!, async (bytes) => {
          if (finished || bytes.length < HEADER || !dec.add(bytes)) return;
          setProgress(dec.progress);
          setInfo({ size: dec.length, frames: dec.frames });
          if (dec.done) {
            finished = true;
            navigator.vibrate?.(120);
            stop?.();
            try {
              setResult(await unpack(dec.result()));
            } catch (e) {
              setError(String(e));
            }
          }
        });
      } catch {
        setError(t('qrNoCamera'));
      }
    })();
    return () => stop?.();
  }, [t]);

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal-card qr-card">
        <div className="modal-head">
          <h2>{t('qrReceive')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('close')}>
            ✕
          </button>
        </div>
        {!result ? (
          <>
            <div className="camera">
              <video ref={video} playsInline muted />
              <div className="camera-frame" />
            </div>
            {error ? <p className="form-error">{error}</p> : <p className="small muted">{t('qrCamera')}</p>}
            <div className="progress">
              <div className="bar" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="mono small">
              {t('qrProgress')} {Math.round(progress * 100)}%{info ? ` · ${formatBytes(info.size, lang)} · ${info.frames} QR` : ''}
            </p>
          </>
        ) : (
          <>
            <p className="ok">
              ✓ {t('qrDone')} {result.verified ? `· ${t('verified')}` : `· ${t('checksum')}`}
            </p>
            {result.meta.text && <TextBox text={result.meta.text} />}
            <ReceivedList files={result.files.map((f) => ({ name: f.name, size: f.size, type: f.type, file: f, url: URL.createObjectURL(f), verified: result.verified }))} />
          </>
        )}
      </div>
    </div>
  );
}

export function TextBox({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const isUrl = /^https?:\/\/\S+$/.test(text.trim());
  return (
    <div className="textbox">
      {isUrl ? (
        <a href={text.trim()} target="_blank" rel="noreferrer noopener">
          {text}
        </a>
      ) : (
        <pre>{text}</pre>
      )}
      <button
        className="btn small"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
        }}
      >
        {copied ? t('copied') : t('copy')}
      </button>
    </div>
  );
}
