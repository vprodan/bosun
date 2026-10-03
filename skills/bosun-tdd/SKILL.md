---
name: bosun-tdd
description: Use when the user asks for test-first or TDD, or when adding new behaviour with a clear contract. Red, green, refactor, one small behaviour at a time, with the tester role writing the failing test and a cheaper lane making it pass.
---

# bosun-tdd

For each behaviour (keep each one small):

1. **Red.** Call the **tester** role: "write one failing test for <behaviour>, run it, show the failure". Check that it fails for the right reason: an assertion, not a typo or an import error.
2. **Green.** Send the minimal implementation spec to the local lane (if mechanical) or the **worker** role (if it needs reasoning), with the test as the verify command. Run the test yourself: it must pass, and the file's other tests must still pass.
3. **Refactor**, only if duplication or naming is now clearly wrong. The tests stay green afterwards.
4. Move on to the next behaviour.

Never write the implementation before you've seen the red output. Never weaken a test to make it pass.
