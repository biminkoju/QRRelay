/**
 * Screen Wake Lock is an enhancement, never a guarantee. Every call is
 * feature-detected and failures are swallowed: a missing wake lock must not
 * break a session, it only risks the display sleeping.
 */

export interface WakeLockHandle {
  supported: boolean;
  release(): Promise<void>;
}

type Sentinel = { released: boolean; release(): Promise<void> };
type WakeLockApi = { request(type: 'screen'): Promise<Sentinel> };

function api(): WakeLockApi | null {
  return (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock ?? null;
}

export async function acquireWakeLock(): Promise<WakeLockHandle> {
  const wakeLock = api();
  if (!wakeLock) return { supported: false, release: async () => {} };
  try {
    const sentinel = await wakeLock.request('screen');
    return {
      supported: true,
      release: async () => {
        if (!sentinel.released) await sentinel.release();
      },
    };
  } catch {
    return { supported: false, release: async () => {} };
  }
}
