import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Router } from '../src/core/ports/router.ts';
import { BosunError } from '../src/core/errors.ts';
import { createRoutePrompt } from '../src/core/use-cases/route-prompt.ts';

type Fixture = { router: Router; calls(): number; close(): Promise<void> };
// Implemented acceptance suite: future decision adapters reuse it with deterministic offline fixtures.
export function routerContract(name: string, setup: () => Promise<Fixture>) {
  test(`Router contract (${name}): public decision and deterministic high-risk fence`, async () => {
    const fixture = await setup();
    try {
      const route = createRoutePrompt({ router: fixture.router, minConfidence: 0.7 });
      const result = await route({ text: 'implement refund in payment-service', privacy: 'public' }, new AbortController().signal);
      assert.equal(result?.final, 'main');
      assert.equal(result?.decision.router, fixture.router.label);
      assert.equal(result?.decision.risk, 'high');
      assert.equal(fixture.calls(), 1);
    } finally { await fixture.close(); }
  });
  test(`Router contract (${name}): private/unknown input never reaches transport`, async () => {
    const fixture = await setup();
    try {
      for (const privacy of ['private', 'unknown'] as const) {
        await assert.rejects(fixture.router.classify({ text: 'PRIVATE-CONTRACT-CANARY', privacy }, new AbortController().signal),
          (error) => error instanceof BosunError && error.code === 'private_input');
      }
      assert.equal(fixture.calls(), 0);
    } finally { await fixture.close(); }
  });
}
