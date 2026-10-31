/** Conservative defaults used when calibration has been skipped. */
export interface ReliableConfig {
  chunkSize: number;
  ackTimeoutMs: number;
  maxRetries: number;
  completeLingerMs: number;
  finLingerMs: number;
  abortLingerMs: number;
  idleTimeoutMs: number;
}

export const DEFAULT_CONFIG: ReliableConfig = {
  chunkSize: 384,
  ackTimeoutMs: 5000,
  maxRetries: 10,
  completeLingerMs: 60000,
  finLingerMs: 15000,
  abortLingerMs: 10000,
  idleTimeoutMs: 30000,
};

/** Monotonic clock; the protocol never depends on wall-clock time. */
export interface Clock {
  now(): number;
}

export const performanceClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};
