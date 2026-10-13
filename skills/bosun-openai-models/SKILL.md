---
name: bosun-openai-models
description: Select, compare, or update OpenAI models and reasoning settings for bosun roles, Codex, ChatGPT Work, or API providers. Use for GPT-6.1 Sol, Astra, Luna, model migrations, and usage tradeoffs; ordinary coding does not require this skill.
---

# OpenAI model selection for bosun

Identify the target surface first: the current host, a Codex CLI executor, ChatGPT Work, or a direct API provider. A model name alone does not establish account access, allowed reasoning settings, tools, or billing.

Read [the model reference](references/models.md) for the dated baseline and bosun configuration mapping. Search and open current official documentation for the exact requested model before changing a recommendation. Prefer `learn.chatgpt.com` for Codex/Work and `developers.openai.com` for APIs. When offline, label the baseline as dated and availability as unverified.

Preserve an explicitly selected model. For an unspecified model, propose a task-appropriate choice using quality, latency, and cost; do not silently replace a requested Astra run with Sol or a requested Sonnet run with an OpenAI model. A subagent model override is subject to the current host's delegation rules.

For a migration:

1. Inspect the relevant defaults, overrides, executor arguments, and tests. In bosun, start at `src/core/domain/config.ts`, `src/platform/config.ts`, `src/core/roles.ts`, `src/app/native-runners.ts`, and the selected host runner. `config.default.env` is the historical upgrade template, not the final runtime's defaults.
2. Verify the exact model ID and supported effort in the target client/provider. API parameters, Codex config values, and ChatGPT UI labels are separate contracts. Report a conflict instead of inventing a translation.
3. Change only the requested role/provider and associated documentation. Preserve effective effort where supported. Do not bulk-replace historical research results or user overrides.
4. Validate argument/config rendering offline. If live comparisons are authorized, use the same representative task and acceptance criteria; record model, effort, surface, latency, and usage. Report quality failures as well as cost.

Subscription credits and API token prices are different measurements. Check current pricing when requested; never estimate included Codex tasks from API dollars. Context length and compaction thresholds must come from the active host/model configuration, not an API catalog alone.

While working on this repository, follow `RESUME.md`: Node tooling, no Bun tests, no installation or personal configuration writes unless explicitly requested. This skill provides guidance; it does not change the running session's model.
