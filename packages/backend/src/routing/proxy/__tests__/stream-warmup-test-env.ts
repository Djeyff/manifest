/**
 * Loaded FIRST by proxy-fallback.service.spec.ts so the real stream-warmup
 * module captures the short window when it is imported. The spec's jest.mock
 * spread of STREAM_WARMUP_MS cannot change peekStream's 15s default binding
 * inside stream-warmup's own module scope, so stalled-stream tests waited the
 * full 15s and died at jest's 5s per-test timeout.
 */
process.env.STREAM_WARMUP_MS = '50';
