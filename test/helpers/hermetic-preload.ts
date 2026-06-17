/**
 * Global Bun test bootstrap.
 *
 * Plain `bun test` used to inherit the operator's real HOME, GBRAIN_HOME,
 * DATABASE_URL, and thin-client remote credentials. That let unit tests read
 * `~/.gbrain/config.json`, create real lock files, or route CLI subprocesses
 * into a live remote doctor path. This preload runs before test files import
 * project modules, so config/path helpers see a sandbox by default.
 *
 * Named integration runners can opt back into external resources with:
 *   GBRAIN_TEST_ALLOW_DATABASE_URL=1   keep DATABASE_URL/GBRAIN_DATABASE_URL
 *   GBRAIN_TEST_ALLOW_REAL_HOME=1      do not redirect HOME/GBRAIN_HOME
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bunTest from 'bun:test';

const allowRealHome = process.env.GBRAIN_TEST_ALLOW_REAL_HOME === '1';
const allowDatabaseUrl = process.env.GBRAIN_TEST_ALLOW_DATABASE_URL === '1';
const keepSandbox = process.env.GBRAIN_KEEP_TEST_HOME === '1';

process.env.GBRAIN_TEST_MODE = '1';
const defaultTimeoutMs = Number(process.env.GBRAIN_TEST_TIMEOUT_MS ?? 120000);
bunTest.setDefaultTimeout(defaultTimeoutMs);

const hookWithDefaultTimeout =
  <T extends (fn: () => unknown | Promise<unknown>, timeout?: number) => void>(hook: T): T =>
    ((fn: () => unknown | Promise<unknown>, timeout?: number) =>
      hook(fn, timeout ?? defaultTimeoutMs)) as T;

const copyRunnerProperties = (target: any, source: any): void => {
  for (const key of Reflect.ownKeys(source)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(target, key, descriptor);
    } catch {
      // Some function metadata is not configurable; helper properties are.
    }
  }
};

const runnerHelper = (runner: any, key: string): Function | undefined => {
  try {
    const value = runner[key];
    return typeof value === 'function' ? value : undefined;
  } catch {
    return undefined;
  }
};

const callableWithDefaultTimeout = (runner: any): any => {
  const wrapped = ((name: string, fn: unknown, optionsOrTimeout?: unknown) =>
    runner(name, fn, optionsOrTimeout ?? defaultTimeoutMs)) as any;
  copyRunnerProperties(wrapped, runner);
  const each = runnerHelper(runner, 'each');
  if (each) {
    wrapped.each = (table: unknown, ...rest: unknown[]) =>
      callableWithDefaultTimeout(each.call(runner, table, ...rest));
  }
  const skipIf = runnerHelper(runner, 'skipIf');
  if (skipIf) {
    wrapped.skipIf = (condition: unknown, ...rest: unknown[]) =>
      callableWithDefaultTimeout(skipIf.call(runner, condition, ...rest));
  }
  const onlyIf = runnerHelper(runner, 'if');
  if (onlyIf) {
    wrapped.if = (condition: unknown, ...rest: unknown[]) =>
      callableWithDefaultTimeout(onlyIf.call(runner, condition, ...rest));
  }
  for (const passthrough of ['skip', 'todo'] as const) {
    const helper = runnerHelper(runner, passthrough);
    if (helper) {
      wrapped[passthrough] = helper.bind(runner);
    }
  }
  return wrapped;
};

const testWithDefaultTimeout = (runner: any): any => {
  const wrapped = callableWithDefaultTimeout(runner);
  const only = runnerHelper(runner, 'only');
  if (only) {
    wrapped.only = callableWithDefaultTimeout(only.bind(runner));
  }
  return wrapped;
};

bunTest.mock.module('bun:test', () => ({
  ...bunTest,
  test: testWithDefaultTimeout(bunTest.test),
  it: testWithDefaultTimeout(bunTest.it),
  beforeAll: hookWithDefaultTimeout(bunTest.beforeAll),
  beforeEach: hookWithDefaultTimeout(bunTest.beforeEach),
  afterAll: hookWithDefaultTimeout(bunTest.afterAll),
  afterEach: hookWithDefaultTimeout(bunTest.afterEach),
}));

const serializePgliteInit = async (): Promise<void> => {
  const patchMarker = Symbol.for('gbrain.test.serializePgliteInit');
  const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
  const proto = PGLiteEngine.prototype as any;
  if (proto[patchMarker] || process.env.GBRAIN_TEST_SERIALIZE_PGLITE_INIT === '0') return;

  const originalInitSchema = proto.initSchema;
  let queue = Promise.resolve();

  proto.initSchema = function serializedInitSchema(...args: unknown[]) {
    const run = () => originalInitSchema.apply(this, args);
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  };
  Object.defineProperty(proto, patchMarker, { value: true });
};

let sandboxRoot: string | null = null;

if (!allowRealHome) {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'gbrain-test-sandbox-'));
  const home = join(sandboxRoot, 'home');
  const gbrainHome = join(sandboxRoot, 'gbrain-home');

  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });

  process.env.GBRAIN_TEST_SANDBOX_ROOT = sandboxRoot;
  process.env.HOME = home;
  process.env.GBRAIN_HOME = gbrainHome;
}

if (!allowDatabaseUrl) {
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.GBRAIN_DIRECT_DATABASE_URL;
}

// Remote credentials are never needed by the default unit tier. Tests that
// exercise remote client behavior build explicit fixture configs instead.
delete process.env.GBRAIN_REMOTE_CLIENT_SECRET;

await serializePgliteInit();

if (sandboxRoot && !keepSandbox) {
  process.on('exit', () => {
    try {
      rmSync(sandboxRoot!, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; failing here would hide the real test result.
    }
  });
}
