/**
 * Focused regression test for the `InvalidAgentKey` self-heal.
 *
 * Reproduces the reported bug: a saved agent secret that playit rejects with
 * `InvalidAgentKey` (the agent was removed from the account) must not fail the
 * tunnel forever — the dead secret should be cleared and the claim flow re-run.
 *
 * No test framework in this project, so this is a standalone ts-node script:
 *   npx ts-node scratch/test-invalid-agent-key.ts
 */
import { PlayitManager } from '../src/managers/playitManager';

const INVALID_KEY_ERR =
  'playit API /agents/rundata failed: {"type":"auth","message":"InvalidAgentKey"}';

function fakeConfig(secret?: string): any {
  const store: any = { playitSettings: secret ? { secret } : {} };
  return {
    getConfig: () => store,
    updatePlayitTunnel: (d: any) => { store.playitSettings = { ...store.playitSettings, ...d }; },
    setPlayitSecret: (s: string) => { store.playitSettings.secret = s; },
    getServer: () => null,
  };
}

let failures = 0;
function assert(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}`);
  if (!cond) failures++;
}

(async () => {
  // 1. The detection predicate.
  const pm: any = new PlayitManager(fakeConfig('a'.repeat(64)));
  assert('isInvalidAgentKey detects the real playit error', pm.isInvalidAgentKey(new Error(INVALID_KEY_ERR)));
  assert('isInvalidAgentKey ignores unrelated errors', !pm.isInvalidAgentKey(new Error('AgentVersionTooOld')));

  // 2. Recovery: a rejected saved secret is cleared and a fresh one is claimed.
  const cfg = fakeConfig('dead'.padEnd(64, '0'));
  const pm2: any = new PlayitManager(cfg);
  let reclaimed: boolean = false;
  pm2.getRunData = async (s: string) => {
    if (s === cfg.getConfig().playitSettings.secret && !reclaimed) throw new Error(INVALID_KEY_ERR);
    return { agent_id: 'A', tunnels: [] };
  };
  pm2.ensureSecret = async () => {
    const cur = cfg.getConfig().playitSettings.secret;
    if (cur) return cur;            // saved secret present -> reuse
    reclaimed = true;               // none saved -> "claim" a fresh one
    const fresh = 'f'.repeat(64);
    cfg.setPlayitSecret(fresh);
    return fresh;
  };
  const recovered = await pm2.ensureValidSecret({});
  assert('dead secret triggers a re-claim', reclaimed);
  assert('ensureValidSecret returns the fresh secret', recovered === 'f'.repeat(64));
  assert('dead secret was actually cleared from config', cfg.getConfig().playitSettings.secret === 'f'.repeat(64));

  // 3. Happy path: a valid saved secret is kept as-is, no re-claim.
  const cfg3 = fakeConfig('b'.repeat(64));
  const pm3: any = new PlayitManager(cfg3);
  pm3.getRunData = async () => ({ agent_id: 'A', tunnels: [] });
  let claimed3: boolean = false;
  pm3.ensureSecret = async () => {
    const cur = cfg3.getConfig().playitSettings.secret;
    if (!cur) claimed3 = true;
    return cur || 'x';
  };
  const kept = await pm3.ensureValidSecret({});
  assert('valid secret is kept unchanged', kept === 'b'.repeat(64));
  assert('no re-claim when the secret is valid', !claimed3);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
