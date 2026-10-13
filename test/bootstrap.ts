// This must be the first dependency of every test file, before any application module.
const guard = (globalThis as any)[Symbol.for('bosun.test.guard')];
if (!guard) throw new Error('bosun tests require scripts/run-tests.mjs; direct test runs are prohibited');
guard.assertEnvironment(process.env);
