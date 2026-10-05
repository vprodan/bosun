---
name: bosun-chatgpt
description: Research ChatGPT Chat, Work, and Codex capabilities for bosun, including model availability, subscription usage, plugins, and moving work between surfaces. Use for product and integration decisions, not generic application work.
---

# ChatGPT surfaces and bosun

Identify whether the request concerns Chat, ChatGPT Work, Codex CLI/desktop/IDE, or a direct OpenAI API. Use the exact surface in the answer and configuration. Read current official documentation for the requested feature; prioritize `learn.chatgpt.com` for product behavior and `developers.openai.com` for APIs.

## Decision guide

The [Work introduction](https://learn.chatgpt.com/docs/get-started-with-work), checked 2026-10-03, describes Chat for conversation and short answers, and Work for completing tasks with deliverables using available files, plugins, and tools. Codex is the relevant integration surface for bosun's existing coding-agent execution. Choose based on the actual task and tools exposed in the session, not the product name alone.

For current models and reasoning controls, read [Models](https://learn.chatgpt.com/docs/models); the adjacent `bosun-openai-models` skill contains a dated bosun-specific baseline. A model documented for Work/Codex is not automatically a Chat model. Rollout, plan, workspace policy, and client version can restrict access.

[Pricing](https://learn.chatgpt.com/docs/pricing) states that Work and Codex share usage. Do not route between these surfaces expecting separate quotas. Keep subscription credits, API charges, and local-model costs distinct. Verify live account limits through supported client information when available; otherwise report them as unknown.

## Integration boundaries

Bosun v1.0's recorded decision is host-agent orchestration with a separate ModelProvider port, and no ChatGPT-plan calls for bosun's own inference in v1.0. Researching a newly supported integration does not automatically replace that decision. Record new evidence and its implications before proposing a change.

Use only available tools and supported authentication mechanisms. A ChatGPT login is not a generic OpenAI API key. Inspect tool capabilities before promising file, browser, connector, or background-work access. Do not copy credentials or local session databases into a cross-machine handoff.

For a concrete deliverable, specify the outcome, source files, constraints, destination, and acceptance checks. Carry unresolved questions and existing authorization boundaries into a handoff. A file can transfer task state; it does not transfer a running process, account access, or proof that tools are connected.

When reporting findings, include the surface, check date, direct official sources, and any observed-versus-documented mismatch. Keep future capabilities labeled as research until supported and verified in the intended client.
