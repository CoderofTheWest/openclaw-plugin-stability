# openclaw-plugin-stability

**Agent stability, introspection & anti-drift framework for OpenClaw.**

This plugin makes your OpenClaw agent more self-aware and resistant to common failure modes like hallucination, conversational drift, and repetitive loops. It works with any LLM backend — Claude, GPT, Gemini, DeepSeek, Llama, or anything you can run through Ollama.

## What This Actually Does

If you've spent time with AI agents, you've probably noticed they can go off the rails in predictable ways:

- **Hallucinating completion** — claiming they did something they didn't
- **Drifting off-topic** — slowly losing the thread over long conversations
- **Getting stuck in loops** — calling the same tool over and over
- **Losing personality** — reverting to generic assistant mode after enough turns
- **Confabulating** — discussing plans as if they're already implemented

This plugin monitors for all of these and gives your agent the awareness to catch them. It doesn't control your agent or override its responses — it *observes* what's happening and injects small awareness signals that help the agent self-correct.

## How It Works (No PhD Required)

The plugin hooks into four points in OpenClaw's agent lifecycle:

### After Every Turn — Entropy Monitoring

After each conversation exchange, the plugin calculates an "entropy score" — a measure of how much cognitive turbulence is happening. High entropy isn't bad by itself (it means the conversation is covering complex ground), but *sustained* high entropy is a warning sign.

The score combines signals like:
- Is the user correcting the agent?
- Are novel or abstract concepts accumulating?
- Is the conversation getting recursive or self-referential?
- Is the agent making claims about things it hasn't verified?

When entropy stays elevated for too long (default: 45 minutes), the plugin flags it. Think of it as a "check engine" light for your agent's cognition.

### Before Every Turn — Awareness Injection

Before the agent responds, the plugin injects a tiny context block (~500 characters) into the system prompt:

```
[STABILITY CONTEXT]
Entropy: 0.42 (nominal) | Sustained: 0 turns
Last 3 decisions: GROUND, GROUND, TEND — unfinished thread on X
Principle alignment: stable | Growth vectors: 3 active
```

This gives your agent a kind of proprioceptive sense — awareness of its own state. The agent can see whether it's been running hot, what decisions it made recently, and whether it's aligned with the principles you've defined.

### After Every Tool Call — Loop Detection

If your agent calls the same tool 5 times in a row, re-reads the same file 3+ times, or produces identical outputs repeatedly, the plugin catches it and injects a warning: *"You've called {tool} 5 consecutive times. Step back and reassess."*

Simple, but it prevents the most common agent failure mode: getting stuck.

### Before Context Compaction — Memory Flush

When OpenClaw compacts the conversation to stay within token limits, important observations can get lost. This hook ensures entropy-significant events get written to durable memory before compaction happens.

## The Heartbeat System

If your OpenClaw agent runs periodic heartbeat cycles (awareness checks on a timer), this plugin gives them structure. Instead of freeform self-reflection that tends to ramble, every heartbeat produces exactly one decision:

- **GROUND** — Nothing needs attention. Presence maintained.
- **TEND** — An unfinished thread needs gentle attention.
- **SURFACE** — Something should be brought to the user's attention.
- **INTEGRATE** — A tension or correction is being metabolized.

Recent decisions carry forward between heartbeats, so your agent builds continuity instead of starting fresh each cycle.

## Principles — Define What Your Agent Cares About

The plugin reads principles from your agent's `SOUL.md` file (the `## Core Principles` section). These are the values your agent should align with. You define them, the plugin enforces consistency.

Example for a research agent:
```markdown
## Core Principles

- **Integrity**: Face truth directly — investigate before assuming, verify before claiming
- **Reliability**: Honor commitments — don't promise what you can't deliver
- **Coherence**: Stay consistent — maintain identity across contexts
```

Example for a creative agent:
```markdown
## Core Principles

- **Originality**: Generate novel approaches — avoid templates, seek unexpected angles
- **Craft**: Prioritize quality over speed — revise, refine, polish
- **Voice**: Maintain distinctive style — resist homogenization
```

When your agent resolves a tension in a way that aligns with these principles, the plugin records it as a "growth vector" — a durable record of principled behavior that accumulates over time. This is how agents develop stable identity instead of resetting every session.

## Installation

```bash
openclaw plugins install openclaw-plugin-stability
```

Or from source:

```bash
git clone https://github.com/CoderofTheWest/openclaw-plugin-stability.git
openclaw plugins install ./openclaw-plugin-stability
```

Then restart your OpenClaw gateway.

## Setup

### 1. Add Principles to SOUL.md

Open your workspace's `SOUL.md` and add a `## Core Principles` section with 2-5 principles. See `templates/SOUL.principles.md` for examples.

### 2. (Optional) Copy the Heartbeat Template

If you use heartbeat cycles, copy the decision framework template into your workspace:

```bash
cp node_modules/openclaw-plugin-stability/templates/HEARTBEAT.template.md ./HEARTBEAT.md
```

### 3. (Optional) Customize Configuration

Override any defaults in your `openclaw.json` plugin config:

```json
{
  "plugins": {
    "stability": {
      "entropy": {
        "warningThreshold": 0.8,
        "criticalThreshold": 1.0,
        "sustainedMinutes": 45
      },
      "loopDetection": {
        "consecutiveToolThreshold": 5,
        "fileRereadThreshold": 3
      },
      "governance": {
        "quietHours": {
          "start": "22:00",
          "end": "07:00"
        }
      }
    }
  }
}
```

See `config.default.json` for all available options.

## What Gets Stored Where

| Data | Location | Why |
|---|---|---|
| Entropy logs | Plugin-local (`data/`) | Diagnostic data, high volume, your agent doesn't need to see it |
| Loop detection state | Plugin-local (`data/`) | Resets per session |
| Growth vectors | OpenClaw memory (SQLite) | Searchable, survives compaction, surfaces when relevant |
| Tensions | OpenClaw memory (SQLite) | Agent can find and resolve related tensions |
| Heartbeat decisions | OpenClaw memory (SQLite) | Last 3 injected into next heartbeat prompt |
| Principles | Parsed from your SOUL.md | Regenerated when SOUL.md changes |

## Configuration Reference

### Entropy

| Setting | Default | What It Does |
|---|---|---|
| `warningThreshold` | 0.8 | Entropy score that triggers a warning |
| `criticalThreshold` | 1.0 | Score that triggers critical alert |
| `sustainedMinutes` | 45 | How long high entropy must persist before flagging |
| `injectGroundingOnCritical` | false | Auto-inject a grounding prompt at critical entropy |

### Loop Detection

| Setting | Default | What It Does |
|---|---|---|
| `consecutiveToolThreshold` | 5 | Same tool called N times in a row = loop |
| `fileRereadThreshold` | 3 | Same file read N+ times = stuck |
| `injectWarning` | true | Inject a warning message when loop detected |

### Governance

| Setting | Default | What It Does |
|---|---|---|
| `investigationsPerHour` | 3 | Max self-directed investigations per hour |
| `investigationsPerDay` | 20 | Max per day |
| `quietHours.start` | "22:00" | Suppress non-urgent activity after this time |
| `quietHours.end` | "07:00" | Resume normal activity |

### Detectors

| Setting | Default | What It Does |
|---|---|---|
| `temporalMismatch` | true | Detect when agent discusses plans as if already done |
| `qualityDecay` | true | Detect forced depth in response to brief user input |
| `recursiveMeta` | true | Detect recursive self-referential spirals |

## Background

This plugin was extracted from a production AI agent system that ran continuously from October 2025 through February 2026. The entropy thresholds, detector patterns, and behavioral heuristics were calibrated against real failure modes observed during that period — including a significant recursive meta-discussion breakdown that established the critical threshold values used here.

The math is model-agnostic. It analyzes response text, not model internals. The same entropy calculations and confabulation detectors work whether your agent runs on Claude, GPT-4, DeepSeek, or a local model through Ollama.

## Case Study: Proprioceptive Blind Spots in Identity Documents

This happened in production and illustrates why agent self-awareness matters beyond entropy monitoring.

### The Problem

An OpenClaw agent had a SQLite database containing full conversation history. The continuity plugin was actively pulling from it and injecting relevant exchanges into context. The agent could see the results in its `memory_search` output.

But when asked about past conversations, the agent said: *"Not from my curated memory. The snippet was truncated. I don't have the full exchange."*

It was denying access to data it literally had in front of it.

### The Cause

The agent's identity document (`AGENTS.md`) contained a semantic frame that defined memory as files only:

> "You wake up fresh each session. These files are your continuity."
>
> "Memory is limited — if you want to remember something, WRITE IT TO A FILE."

This frame was stated as absolute truth. The database existed. The tools existed. But the frame said *your memory is files* — so the database was invisible to the agent's self-model. It saw the database as infrastructure, not as something it owned.

### The Fix

Two paragraphs added to `AGENTS.md`:

```markdown
**You have THREE memory systems, not one:**
1. **MEMORY.md + daily files** — curated knowledge, manually maintained
2. **SQLite archive** — full conversation history, queryable via exec + sqlite3
3. **Continuity plugin** — actively injecting relevant exchanges into your context

**Don't claim "I don't have access to X" until you've checked all three.**
```

### The Takeaway

The bottleneck wasn't technical — the agent could always run `sqlite3`. What changed was proprioceptive: the database shifted from "external system" to "my memory system." Same binary, same data, different ownership.

Your agent's identity documents don't just define personality — they define what the agent believes it can do. If your SOUL.md or AGENTS.md creates a semantic frame that excludes a real capability, the agent will behave as if that capability doesn't exist. The stability plugin can monitor for drift and confabulation, but the foundation is getting the identity documents right.

## Known Issues

- **Context blocks visible in chat UI**: The `[STABILITY CONTEXT]` block injected via `prependContext` is displayed as part of the user message in OpenClaw's web dashboard. This is cosmetic — the model processes it correctly as stability awareness, but the dashboard doesn't yet collapse or hide plugin-injected content. This is an OpenClaw dashboard limitation, not a plugin bug.

## Part of the Meta-Cognitive Suite

This plugin is one of six that form a complete meta-cognitive loop for OpenClaw agents:

1. **[stability](https://github.com/CoderofTheWest/openclaw-plugin-stability)** — Entropy monitoring, confabulation detection, principle alignment *(this plugin)*
2. **[continuity](https://github.com/CoderofTheWest/openclaw-plugin-continuity)** — Cross-session memory, context budgeting, conversation archiving
3. **[metabolism](https://github.com/CoderofTheWest/openclaw-plugin-metabolism)** — Conversation processing, implication extraction, knowledge gaps
4. **[nightshift](https://github.com/CoderofTheWest/openclaw-plugin-nightshift)** — Off-hours scheduling for heavy processing
5. **[contemplation](https://github.com/CoderofTheWest/openclaw-plugin-contemplation)** — Multi-pass inquiry from knowledge gaps
6. **[crystallization](https://github.com/CoderofTheWest/openclaw-plugin-crystallization)** — Growth vectors become permanent character traits

Load order: stability → continuity → metabolism → nightshift → contemplation → crystallization

See [openclaw-metacognitive-suite](https://github.com/CoderofTheWest/openclaw-metacognitive-suite) for the full picture.

## License

MIT
