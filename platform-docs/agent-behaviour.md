---
description: "Customize an agent’s communication style, reasoning, formatting, interaction, and guardrails through settings or chat."
---

# Agent Behaviour

Every agent has a **Behaviour** tab. It controls *how the agent communicates* — how technical it
gets, how long its answers are, its tone, its formatting — separately from what it knows and what
it can do.

Three tabs, three different questions:

| Tab | Question |
|---|---|
| **Settings** | What is this agent? (repository, engine, runner, triggers) |
| **Knowledge** | What does it know? (documents, memory, rules) |
| **Behaviour** | How does it act? |

## Sliders are instructions, not numbers

Move the Technicality slider and the text underneath changes:

> **Senior engineer** — Assume senior-engineer familiarity. Be precise and specific: cite real file
> paths, function names, and short snippets, and skip introductory explanation.

That sentence is exactly what the agent is told. The number is only a way of picking one of a few
described bands — a model does something reliable with "assume senior-engineer familiarity" and
almost nothing with "70/100".

## What you can set

**Style** — technicality · response length · tone · warmth · reply language

**Reasoning** — show its working · how it handles uncertainty · whether to ask when a request is
ambiguous or make a reasonable assumption and say so

**Formatting** — plain prose / light markdown / headings and tables · emoji · code examples

**Interaction** — proactivity · whether it ends with a question · what to call you · a free-text
persona for anything the fields above don't cover

**Guardrails** — stay on topic · never say · cite sources · a hard character limit

## Anything you don't touch stays as it was

A setting you never change contributes nothing. Agents you never visit keep behaving exactly as
they did. There is no hidden default being applied on your behalf — each row shows "default" until
you set it, and a **reset** link once you have.

## You can just say it

You don't have to use the tab. Tell the agent in chat:

> be less technical with me
>
> stop using emoji
>
> keep your answers short

It changes its own settings and can read them back to you. Preferences about *how it talks* belong
here, not in memory — memory is for facts about the subject you work on.

## Guardrails are yours alone

The agent can change its own tone, length and technicality on request. It **cannot** change the
Guardrails group — stay on topic, never say, cite sources, the length limit — even if you ask it
to in chat. Those are editable only by you, in the tab.

This is deliberate. An agent that reads a repository, a web page or an issue tracker is reading
text other people wrote. If instructions hidden in that text could widen the agent's own
restrictions, the restrictions would not be worth having.

## If you publish agents

A creator can ship behaviour defaults with an agent, so it arrives with a character rather than
neutral. Subscribers override individual fields; anything they don't touch keeps your default.

## Instructions a Repo Coder is given

Behaviour is typed style. What a coding agent is *told about the work* is free-text Instructions, and
there are three layers of them, lowest precedence first (a later layer wins where two disagree):

1. **Template defaults** — the provider's (`agents.config.instructions`). Not editable yet, so empty
   today; an empty layer changes nothing.
2. **Special Instructions** — yours, for every repository of the instance (Knowledge → Rules & Tips).
3. **Repository Instructions** — yours, for one registered repository (test commands, conventions).

The Pilot, the co-pilot and every message you send to the engine read these through one resolver, so
there is one answer. See it without guessing: Rules & Tips shows an **Effective playbook** per
repository, `GET /v1/instances/:id/coding/repos/:repoId/playbook` returns it, and MCP
`get_instance_instructions` with `repo_id` reads it.

Instructions are guidance, never permission. They cannot grant a capability or change merge policy,
questions, approvals or mandatory checks; those are typed settings the server enforces on its own.
The **Operator Manual** is a different thing for a different reader: notes for whoever *drives* the
agent (read with `get_instance_operator_manual`), shown to the caller as data, never injected as
instructions to the agent.

Not covered: turns a chat brain composes itself and sends to a repo (`delegate`, send-to-repo) do not
carry these layers — the brain writing them has them — and the runner forwards whatever turn it is
given without resolving anything.
