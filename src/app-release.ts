// Android app: latest GitHub release of this repository (null until the
// first release exists, so the download card only appears when there is one).
import { useEffect, useState } from 'react';

const REPO = 'justapps-it/Just-share';

export interface AndroidRelease {
  url: string;
  releases: string;
  version: string;
  sizeMB: number;
  sha256: string;
}

let cached: Promise<AndroidRelease | null> | undefined;

function fetchLatest() {
  cached ??= fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((r: null | { tag_name: string; html_url: string; assets: { name: string; size: number; digest?: string; browser_download_url: string }[] }) => {
      const apk = r?.assets.find((a) => a.name === 'JustShare.apk');
      if (!r || !apk) return null;
      return {
        url: apk.browser_download_url,
        releases: r.html_url,
        version: r.tag_name.replace(/^android-v/, ''),
        sizeMB: Math.round((apk.size / 1048576) * 10) / 10,
        sha256: apk.digest?.replace(/^sha256:/, '') ?? '',
      };
    })
    .catch(() => null);
  return cached;
}

export function useAndroidRelease() {
  const [r, setR] = useState<AndroidRelease | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchLatest().then((x) => alive && setR(x));
    return () => {
      alive = false;
    };
  }, []);
  return r;
}
