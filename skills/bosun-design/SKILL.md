---
name: bosun-design
description: Use when a change has an open decision - a new feature, a behaviour change, a refactor with options, a cross-service contract - before any code. Clarifies intent, gets options from the architect role, and records the chosen design.
---

# bosun-design

1. `bosun card in-progress "designing: <topic>"`.
2. Restate the goal in two lines: what the user said, and what you assume. Ask at most 3 clarifying questions, one at a time, and only ones whose answer changes the design.
3. Call the **architect** role with the goal, the answers, the repos and files in scope, and the constraints (compatibility, risk areas). Ask for 2-3 options, a recommendation, and an executor-ready spec for the recommended option.
4. Check the options against the code yourself (spot-read the key files). Drop any option that breaks a stated constraint.
5. Present the options in one line each, your recommendation and why (two sentences), and the risks. Ask the user to pick.
6. Record the decision at the top of the plan file and continue with **bosun-plan**.

Skip this skill when the change has one obvious answer, or when the user says "just do X": go straight to **bosun-plan** with X.
