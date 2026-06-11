/**
 * Tests for createHttpShutdown() + HTTP_SHUTDOWN_GRACE_MS in
 * src/commands/serve-http.ts (D1, packet 2026-06-11 — graceful SIGTERM/SIGINT
 * drain for the `serve --http` path).
 *
 * Environment note: this workspace's gbrain is thin-client-configured, so
 * `serve --http` refuses to start locally and a full Express SIGTERM e2e is
 * out of reach here. Acceptance therefore rests on driving the extracted
 * shutdown orchestrator directly with a hand-rolled fake server — no real
 * listener, no open port — exercising the four behaviors that matter:
 *   1. drain-complete path: server.close callback → pools closed → exit 0
 *   2. deadline path: drain hangs → force-close → pools closed → exit 0
 *   3. idempotency: a second signal is a no-op (no double close/exit)
 *   4. ordering: idle connections retired, pools closed before exit
 *
 * Live SIGTERM-on-the-box verification is the named residual (next restart
 * should show `inactive`, not `failed/timeout`).
 */

import { describe, test, expect } from 'bun:test';
import {
  createHttpShutdown,
  HTTP_SHUTDOWN_GRACE_MS,
  type ClosableHttpServer,
} from '../src/commands/serve-http.ts';

/**
 * Fake http.Server. `close(cb)` stashes the callback instead of firing it so a
 * test can decide WHEN (or whether) the drain completes — modelling both a
 * prompt drain and a wedged keep-alive socket. Records the call order of every
 * lifecycle method so ordering assertions read off one array.
 */
function makeFakeServer() {
  const calls: string[] = [];
  let closeCb: (() => void) | undefined;
  const server: ClosableHttpServer & {
    calls: string[];
    fireCloseCallback: () => void;
    closeCalled: boolean;
  } = {
    calls,
    closeCalled: false,
    close(cb?: () => void) {
      this.closeCalled = true;
      calls.push('close');
      closeCb = cb;
    },
    closeIdleConnections() {
      calls.push('closeIdleConnections');
    },
    closeAllConnections() {
      calls.push('closeAllConnections');
    },
    fireCloseCallback() {
      closeCb?.();
    },
  };
  return server;
}

describe('HTTP_SHUTDOWN_GRACE_MS', () => {
  test('exported default grace window is 5000ms', () => {
    expect(HTTP_SHUTDOWN_GRACE_MS).toBe(5_000);
  });
});

describe('createHttpShutdown', () => {
  test('drain-complete path: close → idle sockets retired → pools closed → exit 0', async () => {
    const server = makeFakeServer();
    const order: string[] = [];
    let exitCode: number | undefined;

    const shutdown = createHttpShutdown({
      server,
      closePools: async () => { order.push('closePools'); },
      log: () => {},
      exit: (code) => { exitCode = code; order.push('exit'); },
      graceMs: 10_000, // long — we drive the drain manually, deadline must NOT fire
    });

    shutdown('SIGTERM');

    // Stopped accepting new connections and proactively retired idle sockets.
    expect(server.closeCalled).toBe(true);
    expect(server.calls).toContain('closeIdleConnections');
    // Drain not yet complete → pools still open, no exit.
    expect(order).toEqual([]);

    // Last in-flight request drains → server fires its close callback.
    server.fireCloseCallback();
    await new Promise((r) => setTimeout(r, 0)); // let the closePools microtask settle

    expect(order).toEqual(['closePools', 'exit']);
    expect(exitCode).toBe(0);
    // Drain completed on its own; we never force-closed connections.
    expect(server.calls).not.toContain('closeAllConnections');
  });

  test('deadline path: a hung drain force-closes connections then exits 0', async () => {
    const server = makeFakeServer();
    const order: string[] = [];
    let exitCode: number | undefined;

    const shutdown = createHttpShutdown({
      server,
      closePools: async () => { order.push('closePools'); },
      log: () => {},
      exit: (code) => { exitCode = code; order.push('exit'); },
      graceMs: 20, // short — server.close callback never fires, deadline wins
    });

    shutdown('SIGTERM');
    // Drain deliberately never completes (we don't call fireCloseCallback).
    expect(order).toEqual([]);

    await new Promise((r) => setTimeout(r, 50)); // outlast the 20ms deadline

    // Deadline force-closed remaining sockets, then closed pools + exited.
    expect(server.calls).toContain('closeAllConnections');
    expect(order).toEqual(['closePools', 'exit']);
    expect(exitCode).toBe(0);
  });

  test('idempotent: a second signal does not re-close or double-exit', async () => {
    const server = makeFakeServer();
    let closePoolsCount = 0;
    let exitCount = 0;

    const shutdown = createHttpShutdown({
      server,
      closePools: async () => { closePoolsCount++; },
      log: () => {},
      exit: () => { exitCount++; },
      graceMs: 10_000,
    });

    shutdown('SIGTERM');
    shutdown('SIGINT'); // duplicate — must be a no-op

    server.fireCloseCallback();
    await new Promise((r) => setTimeout(r, 0));

    // server.close called exactly once despite two signals.
    expect(server.calls.filter((c) => c === 'close').length).toBe(1);
    expect(closePoolsCount).toBe(1);
    expect(exitCount).toBe(1);
  });

  test('deadline and drain-callback racing both resolve to a single exit', async () => {
    const server = makeFakeServer();
    let closePoolsCount = 0;
    let exitCount = 0;

    const shutdown = createHttpShutdown({
      server,
      closePools: async () => { closePoolsCount++; },
      log: () => {},
      exit: () => { exitCount++; },
      graceMs: 20,
    });

    shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 50)); // deadline fires → finish()
    server.fireCloseCallback();                  // late drain callback → finish() again
    await new Promise((r) => setTimeout(r, 0));

    // Whichever path wins, pools close once and the process exits once.
    expect(closePoolsCount).toBe(1);
    expect(exitCount).toBe(1);
  });

  test('a rejecting closePools still exits 0 (disconnect can never trap the process)', async () => {
    const server = makeFakeServer();
    let exitCode: number | undefined;
    let logged = '';

    const shutdown = createHttpShutdown({
      server,
      closePools: async () => { throw new Error('pool wedged'); },
      log: (m) => { logged += m; },
      exit: (code) => { exitCode = code; },
      graceMs: 10_000,
    });

    shutdown('SIGTERM');
    server.fireCloseCallback();
    await new Promise((r) => setTimeout(r, 0));

    expect(exitCode).toBe(0);
    expect(logged).toContain('pool close error');
    expect(logged).toContain('pool wedged');
  });
});
