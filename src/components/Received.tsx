import { zipSync } from 'fflate';
import { formatBytes, useI18n } from '../i18n';
import type { ReceivedFile } from '../store';

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name.split('/').pop() || name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function saveZip(files: ReceivedFile[]) {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name] = new Uint8Array(await f.file.arrayBuffer());
  const url = URL.createObjectURL(new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: 'application/zip' }));
  download(url, 'justshare.zip');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ReceivedList({ files }: { files: ReceivedFile[] }) {
  const { t, lang } = useI18n();
  const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: files.map((f) => f.file) });
  return (
    <div className="received">
      <ul>
        {files.map((f) => (
          <li key={f.name}>
            {f.type.startsWith('image/') ? <img src={f.url} alt="" /> : <span className="file-ico">{(f.name.split('.').pop() || '?').slice(0, 4).toUpperCase()}</span>}
            <span className="file-name" title={f.name}>
              {f.name}
              <small>
                {formatBytes(f.size, lang)}
                {f.verified ? ` · ✓ ${t('verified')}` : ` · ${t('checksum')}`}
              </small>
            </span>
            <button className="btn small accent" onClick={() => download(f.url, f.name)}>
              {t('save')}
            </button>
          </li>
        ))}
      </ul>
      <div className="row wrap">
        {files.length > 1 && (
          <button className="btn small" onClick={() => void saveZip(files)}>
            {t('saveAll')}
          </button>
        )}
        {canShare && (
          <button className="btn small" onClick={() => void navigator.share({ files: files.map((f) => f.file) }).catch(() => {})}>
            {t('share')}
          </button>
        )}
      </div>
    </div>
  );
}
