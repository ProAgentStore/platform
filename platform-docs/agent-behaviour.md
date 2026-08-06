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
