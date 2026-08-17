/**
 * Tagged influencer watchlist service. No auto-buys — copy modules stay off
 * unless the operator enables them separately.
 */

import { isUpgradeEnabled } from '../registry';
import { isLoadServiceEnabled } from './systemLoadMode';

let timer: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;

export function getInfluencerMirrorStatus(): {
  enabled: boolean;
  lastTickAt: number;
} {
  return {
    enabled: isUpgradeEnabled('influencer_mirror') && timer != null,
    lastTickAt,
  };
}

export function enableInfluencerMirror(): void {
  if (timer) return;
  if (!isLoadServiceEnabled('influencer_mirror')) {
    console.log(
      '[upgrades] influencer_mirror skipped — System Load Mode extras off'
    );
    return;
  }
  timer = setInterval(() => {
    lastTickAt = Date.now();
  }, 120_000);
  lastTickAt = Date.now();
  console.log(
    '[upgrades] influencer_mirror ON — tagged mirror service armed (no auto-buys until copy modules on)'
  );
}

export function disableInfluencerMirror(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log('[upgrades] influencer_mirror OFF');
}