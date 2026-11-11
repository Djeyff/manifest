import {
  KeyQuotaHaltRegistry,
  type KeyQuotaHaltRef,
} from './key-quota-halt';

describe('KeyQuotaHaltRegistry (RET-647)', () => {
  const FLUSH = 1_700_000_000_000;
  const ref = (over: Partial<KeyQuotaHaltRef> = {}): KeyQuotaHaltRef => ({
    tenantId: 'tenant-1',
    connectionId: 'conn-9',
    provider: 'zai',
    authType: 'api_key',
    keyLabel: 'KaanAssistV2',
    model: 'glm-5.3',
    secret: 'sk-dead-key',
    ...over,
  });

  it('marks the exact key dead until the provider window flush', () => {
    const reg = new KeyQuotaHaltRegistry(2_000, () => FLUSH - 60_000);
    reg.halt(ref(), FLUSH);
    expect(reg.haltedUntil(ref())).toBe(FLUSH);
    expect(reg.size()).toBe(1);
  });

  it('never affects a different key on the same route (funded fallback serves attempt-1)', () => {
    const reg = new KeyQuotaHaltRegistry(2_000, () => FLUSH - 60_000);
    reg.halt(ref(), FLUSH);
    expect(reg.haltedUntil(ref({ secret: 'sk-funded-backup' }))).toBeNull();
    expect(reg.haltedUntil(ref({ keyLabel: 'Backup' }))).toBeNull();
    expect(reg.haltedUntil(ref({ provider: 'minimax' }))).toBeNull();
  });

  it('auto-revives the key at the provider window reset (simulated flush)', () => {
    let now = FLUSH - 60_000;
    const reg = new KeyQuotaHaltRegistry(2_000, () => now);
    reg.halt(ref(), FLUSH);
    expect(reg.haltedUntil(ref())).toBe(FLUSH);
    now = FLUSH; // window reset
    expect(reg.haltedUntil(ref())).toBeNull(); // lazy revive on read
    expect(reg.size()).toBe(0); // corpse removed
    reg.halt(ref(), FLUSH + 3_600_000);
    expect(reg.reviveExpired(FLUSH + 3_600_001)).toBe(1); // active sweep also revives
  });

  it('ignores refs without tenant or secret (fail-open, never skip a usable key)', () => {
    const reg = new KeyQuotaHaltRegistry(2_000, () => FLUSH - 1_000);
    reg.halt(ref({ tenantId: undefined }), FLUSH);
    reg.halt(ref({ secret: '' }), FLUSH);
    expect(reg.size()).toBe(0);
    expect(reg.haltedUntil(ref({ tenantId: undefined }))).toBeNull();
  });

  it('stores per (tenant, connection, provider, auth, label, model) so one model never blocks another', () => {
    const reg = new KeyQuotaHaltRegistry(2_000, () => FLUSH - 1_000);
    reg.halt(ref(), FLUSH);
    expect(reg.haltedUntil(ref({ model: 'glm-5.3-flash' }))).toBeNull();
  });
});
