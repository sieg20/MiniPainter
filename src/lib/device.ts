// Decides whether the AI selector should run on this device.
// SlimSAM's image analysis briefly needs 1–2 GB of memory; phone browsers kill
// (and reload) the page when it does, so phones default to Smart fill instead.

const PREF = 'mini-painter:ai'; // 'on' | 'off' — the user's own choice
const BUSY = 'mini-painter:ai-busy'; // set while the AI analyses a photo

function read(store: Storage | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(store: Storage | undefined, key: string, v: string | null) {
  try {
    if (v === null) store?.removeItem(key);
    else store?.setItem(key, v);
  } catch {
    /* storage blocked */
  }
}

const session = typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
const local = typeof localStorage === 'undefined' ? undefined : localStorage;

/** Phones and tablets, plus anything reporting 4 GB of memory or less. */
export function isLowMemoryDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) return true;
  const ua = nav.userAgent;
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;
  // iPadOS reports itself as a Mac.
  return /Macintosh/.test(ua) && nav.maxTouchPoints > 1;
}

/** True if the page was reloaded while the AI was analysing a photo, i.e. the browser ran out of memory. */
export function aiCrashedLastTime(): boolean {
  const crashed = read(session, BUSY) !== null;
  write(session, BUSY, null);
  return crashed;
}

export const aiBusy = {
  start: () => write(session, BUSY, '1'),
  end: () => write(session, BUSY, null),
};

export const aiPref = {
  get: (): 'on' | 'off' | null => {
    const v = read(local, PREF);
    return v === 'on' || v === 'off' ? v : null;
  },
  set: (v: 'on' | 'off') => write(local, PREF, v),
};
