// Monotonic clock used to timestamp capture events.
//
// Video and audio are captured by a single process and muxed onto one shared
// timeline, so A/V sync is inherent. This clock adds an independent,
// jump-free monotonic reference (process.hrtime) so lifecycle events and the
// capture session itself can be correlated with wall-clock logs and the STT
// transcript without drifting when the system clock is adjusted.

/**
 * Current monotonic nanoseconds since an arbitrary fixed point.
 * Do NOT use for cross-process comparison; use a shared MonotonicClock.
 */
function nowNs() {
  return process.hrtime.bigint();
}

class MonotonicClock {
  /**
   * @param {bigint} [originNs] monotonic origin; defaults to now
   */
  constructor(originNs = nowNs()) {
    this.originNs = originNs;
    // Best-effort wall-clock anchor captured as close as possible to the origin.
    this.originWallMs = Date.now();
    this.originIso = new Date(this.originWallMs).toISOString();
  }

  /** Monotonic nanoseconds elapsed since this clock's origin. */
  elapsedNs() {
    return nowNs() - this.originNs;
  }

  /** Elapsed seconds as a float. */
  elapsedSec() {
    return Number(this.elapsedNs()) / 1e9;
  }

  /** Wall-clock milliseconds at the current monotonic time. */
  nowWallMs() {
    return this.originWallMs + this.elapsedSec() * 1000;
  }

  /**
   * Convert a media-relative time (seconds since session start, 0-based) into
   * an absolute monotonic timestamp in nanoseconds.
   */
  mediaToMonoNs(mediaSec) {
    return this.originNs + BigInt(Math.round(mediaSec * 1e9));
  }

  /**
   * A serializable sample of the current time. BigInt is represented as a
   * string because JSON cannot encode BigInt.
   * @returns {{tNs: string, tSec: number, wallMs: number, iso: string}}
   */
  sample() {
    const tSec = this.elapsedSec();
    const wallMs = this.originWallMs + tSec * 1000;
    return {
      tNs: this.elapsedNs().toString(),
      tSec,
      wallMs,
      iso: new Date(wallMs).toISOString(),
    };
  }
}

module.exports = { MonotonicClock, nowNs };
