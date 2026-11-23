// This device: a stable random id and a friendly name.
const ADJ_IT = ['Volpe', 'Lince', 'Orso', 'Gufo', 'Delfino', 'Falco', 'Lupo', 'Tasso', 'Riccio', 'Panda', 'Koala', 'Tigre'];
const COL_IT = ['Arancione', 'Blu', 'Verde', 'Viola', 'Rosso', 'Giallo', 'Grigio', 'Rosa', 'Azzurro', 'Nero'];
const ADJ_EN = ['Fox', 'Lynx', 'Bear', 'Owl', 'Dolphin', 'Falcon', 'Wolf', 'Badger', 'Hedgehog', 'Panda', 'Koala', 'Tiger'];
const COL_EN = ['Orange', 'Blue', 'Green', 'Purple', 'Red', 'Yellow', 'Grey', 'Pink', 'Cyan', 'Black'];

export type DeviceType = 'phone' | 'tablet' | 'desktop';

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode */
  }
}

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export function deviceId(): string {
  let id = get('justshare-id');
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, '');
    set('justshare-id', id);
  }
  // A second tab must not steal the first one's identity.
  const tab = sessionStorage.getItem('justshare-tab') ?? Math.random().toString(36).slice(2, 6);
  sessionStorage.setItem('justshare-tab', tab);
  return `${id.slice(0, 24)}-${tab}`;
}

export function deviceName(lang: 'it' | 'en'): string {
  let name = get('justshare-name');
  if (!name) {
    name = lang === 'it' ? `${pick(ADJ_IT)} ${pick(COL_IT)}` : `${pick(COL_EN)} ${pick(ADJ_EN)}`;
    set('justshare-name', name);
  }
  return name;
}

export const saveName = (name: string) => set('justshare-name', name.trim().slice(0, 40));

export function deviceType(): DeviceType {
  const ua = navigator.userAgent;
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|Android/i.test(ua)) return 'phone';
  return 'desktop';
}
