/**
 * #3684 / #3685 regression test: `--json` on `gbrain jobs list`, `jobs get`
 * and `jobs stats`.
 *
 * Pre-fix the flag was parsed by nobody. `src/commands/jobs.ts` read '--json'
 * at exactly two sites — the `supervisor` and `watch` cases — so on
 * `list`/`get`/`stats` it was accepted, discarded, and the human render ran
 * anyway: exit 0, empty stderr, `jq` failing at line 1. CHANGELOG's `jobs
 * watch` migration note points operators at `gbrain jobs stats --json` /
 * `gbrain jobs list --json` as "the cleaner surfaces" for scripting, so the
 * documented surface silently did not exist, and a dead-letter monitor had no
 * signal that its contract was not honored.
 *
 * The two directions both matter, so both are pinned here:
 *   - `--json` emits one parseable document per command (`[]` for an empty
 *     list, not the prose "No jobs found."), and `--cluster-errors` composes
 *     with it rather than being dropped;
 *   - the human renders are untouched, so this cannot be "fixed" by turning
 *     the dashboards into JSON for everyone.
 *
 * Spawn-level on purpose: the defect is in CLI flag handling, which an
 * in-process call cannot observe. Brain setup mirrors
 * test/reindex-frontmatter-pglite-spawn.serial.test.ts. Serial because it
 * spawns subprocesses and writes a tmpdir.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Scrub inherited GBRAIN_* so a developer's shell config can't change what
  // the spawned CLI does.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GBRAIN_')),
  ) as Record<string, string>;
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env: { ...base, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

describe('jobs list/get/stats honor --json (#3684, #3685)', () => {
  test('--json emits parseable documents on all three; human output is unchanged', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-3684-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          database_path: join(home, '.gbrain', 'brain.pglite'),
          embedding_dimensions: 1536,
        }) + '\n',
      );
      const env = { HOME: home, GBRAIN_HOME: home };

      const init = await runCli(['init', '--migrate-only'], env, 120_000);
      if (init.exitCode !== 0) {
        console.error('--- init stdout ---\n' + init.stdout);
        console.error('--- init stderr ---\n' + init.stderr);
      }
      expect(init.exitCode).toBe(0);

      // 'autopilot-global-maintenance' is 28 chars — longer than formatJob's
      // padEnd(14) name column, which is why column-position parsing of the
      // human table is unreliable and JSON is the fix rather than a nicer table.
      for (const name of ['autopilot-global-maintenance', 'short']) {
        const s = await runCli(['jobs', 'submit', name, '--params', '{}'], env, 120_000);
        expect(s.exitCode).toBe(0);
      }

      // list --json: pre-fix this JSON.parse throws on the table header.
      const list = await runCli(['jobs', 'list', '--json'], env, 120_000);
      expect(list.exitCode).toBe(0);
      const jobs = JSON.parse(list.stdout);
      expect(Array.isArray(jobs)).toBe(true);
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j: { name: string }) => j.name).sort())
        .toEqual(['autopilot-global-maintenance', 'short']);
      expect(typeof jobs[0].id).toBe('number');
      expect(typeof jobs[0].status).toBe('string');

      // Empty result is `[]`, not the prose "No jobs found." — a scripted
      // consumer must be able to parse the no-rows case too.
      const dead = await runCli(['jobs', 'list', '--status', 'dead', '--json'], env, 120_000);
      expect(dead.exitCode).toBe(0);
      expect(dead.stdout).not.toContain('No jobs found');
      expect(JSON.parse(dead.stdout)).toEqual([]);

      // get --json: error_text is reachable without regexing prose. This is
      // the field a dead-letter monitor actually needs.
      const get = await runCli(['jobs', 'get', String(jobs[0].id), '--json'], env, 120_000);
      expect(get.exitCode).toBe(0);
      const job = JSON.parse(get.stdout);
      expect(job.id).toBe(jobs[0].id);
      expect(job).toHaveProperty('error_text');

      // stats --json: the surface CHANGELOG names for scripting.
      const stats = await runCli(['jobs', 'stats', '--json'], env, 120_000);
      expect(stats.exitCode).toBe(0);
      const parsedStats = JSON.parse(stats.stdout);
      expect(Array.isArray(parsedStats.by_type)).toBe(true);
      expect(parsedStats.queue_health).toHaveProperty('waiting');
      expect(parsedStats).toHaveProperty('lease_pressure_1h');
      // --queue scopes only the wedge block (getStats' contract), so the scope
      // is reported there rather than as a top-level key.
      expect(parsedStats.wedge.queue).toBe('default');

      // --cluster-errors composes with --json instead of being dropped —
      // silently ignoring a requested flag is the defect being fixed.
      const clustered = await runCli(['jobs', 'stats', '--json', '--cluster-errors'], env, 120_000);
      expect(clustered.exitCode).toBe(0);
      expect(JSON.parse(clustered.stdout)).toHaveProperty('error_clusters');

      // Human renders unchanged in both directions.
      const humanList = await runCli(['jobs', 'list'], env, 120_000);
      expect(humanList.exitCode).toBe(0);
      expect(humanList.stdout).toContain('2 jobs shown');
      const humanStats = await runCli(['jobs', 'stats'], env, 120_000);
      expect(humanStats.exitCode).toBe(0);
      expect(humanStats.stdout).toContain('Job Stats (last 24h):');
      expect(humanStats.stdout).toContain('Queue health:');
      const humanGet = await runCli(['jobs', 'get', String(jobs[0].id)], env, 120_000);
      expect(humanGet.exitCode).toBe(0);
      expect(humanGet.stdout).toMatch(/^Job #\d+: /);

      // The flag is documented where an operator looks for it.
      const usage = await runCli(['jobs'], env, 120_000);
      expect(usage.stdout).toContain('gbrain jobs list [--status S] [--queue Q] [--limit N] [--json]');
      expect(usage.stdout).toContain('gbrain jobs get <id> [--json]');
      expect(usage.stdout).toContain('gbrain jobs stats [--queue Q] [--cluster-errors] [--json]');
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 600_000);
});
