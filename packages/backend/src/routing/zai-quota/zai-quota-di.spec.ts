import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { ZaiQuotaService } from './zai-quota.service';

/**
 * RET-595 hotfix 2 regression guard: the constructor's optional test seams
 * (fetchImpl / env) were undecorated, so Nest DI tried to resolve them as
 * providers and crashed the whole module boot (UnknownDependenciesException,
 * pod mnfs-app-fc87c55fd-pppjf CrashLoopBackOff 2026-11-07T22:16Z). The unit
 * specs construct the service directly and never exercise module DI — this
 * spec compiles a real Nest testing module so the actual DI path is guarded.
 */
describe('ZaiQuotaService — Nest DI wiring (RET-595 hotfix 2)', () => {
  function moduleUnderTest() {
    return Test.createTestingModule({
      providers: [
        ZaiQuotaService,
        { provide: getRepositoryToken(TenantProvider), useValue: { find: async () => [] } },
      ],
    });
  }

  it('resolves ZaiQuotaService with only the repository provided (seams @Optional)', async () => {
    const moduleRef = await moduleUnderTest().compile();
    const svc = moduleRef.get(ZaiQuotaService);
    expect(svc).toBeInstanceOf(ZaiQuotaService);
    await moduleRef.close();
  });

  it('boots and tears down through the full Nest lifecycle without open handles', async () => {
    const moduleRef = await moduleUnderTest().compile();
    const app = moduleRef.createNestApplication();
    await app.init(); // onModuleInit schedules the poller (BOOT_DELAY 5s)
    await app.close(); // onModuleDestroy clears the timer
  });
});
