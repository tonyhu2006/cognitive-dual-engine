# cognitive-dual-engine

An [OpenClaw](https://openclaw.ai/) plugin that implements **System 1 / System 2 cognitive routing** for AI agents, powered by the **FLARE** (Future-aware LookAhead with Reward Estimation) planning framework.

## What It Does

Before the AI agent acts on any task, this plugin injects a **meta-cognition layer** that:

1. **Assesses task complexity** across 6 dimensions (logical depth, tool dependency, ambiguity, cross-domain complexity, state dependency, latency tolerance)
2. **Routes to the optimal processing path:**
   - **System 1 (Intuition)** — Simple tasks: fast, direct LLM generation
   - **System 2 (FLARE Planning)** — Complex tasks: lookahead tree search with backward value propagation and limited commitment planning

## Academic Foundations

- **DeepMind** — *Context Structure Reshapes the Representational Geometry of Language Models* (arXiv:2601.22364): Representational straightening in continuous prediction tasks → System 1 theory
- **Stanford** — *Why Reasoning Fails to Plan* (arXiv:2601.22311): FLARE framework with explicit lookahead, backward value propagation, and limited commitment → System 2 implementation

## Install

```bash
openclaw plugins install cognitive-dual-engine
```

## Configuration

In `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "cognitive-dual-engine": {
        "enabled": true,
        "config": {
          "system2Threshold": 0.55,
          "flareMaxDepth": 3,
          "flareBranchFactor": 3,
          "flareSimulationsPerNode": 2
        }
      }
    }
  }
}
```

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `system2Threshold` | `0.55` | 0.1 – 0.99 | Complexity score threshold for System 2 activation |
| `flareMaxDepth` | `3` | 1 – 5 | Maximum search tree depth |
| `flareBranchFactor` | `3` | 1 – 5 | Candidate actions generated per node |
| `flareSimulationsPerNode` | `2` | 1 – 5 | Monte Carlo simulations per node expansion |

## Usage

Once installed, the plugin works **automatically**:

- The `agent:bootstrap` hook injects routing instructions into the agent's system prompt
- The agent calls `cognitive_assess` before every task
- Complex tasks automatically trigger `flare_plan` for optimized planning
- The `tool_result_persist` hook enforces **limited commitment** — clearing stale hypotheses after each action

## Commands

### `/cogstatus` — View Current State

Shows active sessions, routing decisions, complexity scores, and current config.

### `/cogtune` — Runtime Parameter Tuning

Adjust FLARE engine parameters **at runtime** without restarting the gateway. Every change instantly shows the estimated LLM API call count so you can balance quality vs. cost.

#### Set Individual Parameters

```
/cogtune threshold 0.75     Set System 2 activation threshold
/cogtune depth 2             Set search tree max depth
/cogtune branch 2            Set candidate actions per node
/cogtune simulations 1       Set Monte Carlo simulations per node
/cogtune sims 1              Alias for simulations
```

#### Apply Presets

```
/cogtune preset minimal      Lowest API usage (~5 LLM calls per FLARE)
/cogtune preset balanced     Good balance of quality & cost (~14 calls)
/cogtune preset thorough     Maximum planning depth (~118 calls, default)
```

| Preset | Threshold | Depth | Branch | Sims | Est. LLM Calls |
|--------|-----------|-------|--------|------|-----------------|
| `minimal` | 0.80 | 1 | 2 | 1 | ~5 |
| `balanced` | 0.55 | 2 | 2 | 1 | ~14 |
| `thorough` | 0.40 | 3 | 3 | 2 | ~118 |

#### Other Subcommands

```
/cogtune                     Show current config + estimated LLM calls
/cogtune reset               Reset all parameters to defaults
```

#### Input Validation

- Values are clamped to valid ranges automatically (e.g., depth clamped to 1–5)
- Invalid input returns a clear error message
- After every change, the estimated LLM call count is displayed

## LLM API Call Analysis

> **Important**: The FLARE planning engine makes multiple internal LLM API calls to build its search tree. Understanding this cost structure is critical for managing rate limits (RPM) and token budgets (TPM).

### Where LLM Calls Happen

The plugin has **3 LLM call points**, all inside the FLARE engine's LLM Simulator:

| Function | When Called | Purpose | Est. Tokens/Call |
|----------|------------|---------|-----------------|
| `generateActionCandidates()` | Each non-leaf node expansion | Generate N candidate next actions | 200–500 |
| `simulateStateTransition()` | Each candidate × simulations | Predict next state + reward | 150–300 |
| `evaluateTerminalValue()` | Each leaf node | Evaluate task completion at leaf | 100–200 |

### Call Count Formula

For a search tree with depth `d`, branch factor `b`, and simulations `s`:

```
Non-leaf nodes   = Σ(b^i) for i=0..d-1   = (b^d - 1) / (b - 1)
Leaf nodes       = b^d

Total LLM calls  = non-leaf × (1 + b×s)  +  leaf × 1
                   ├─ generate ─┤ ├─ simulate ─┤  ├─ evaluate ─┤
```

### Call Count by Configuration

| Configuration | Non-Leaf | Leaf | Generate | Simulate | Evaluate | **Total** |
|---------------|----------|------|----------|----------|----------|-----------|
| **Default** (d=3, b=3, s=2) | 13 | 27 | 13 | 78 | 27 | **118** |
| **Balanced** (d=2, b=2, s=1) | 3 | 4 | 3 | 6 | 4 | **13** |
| **Minimal** (d=1, b=2, s=1) | 1 | 2 | 1 | 2 | 2 | **5** |

### Zero-Cost Path: `cognitive_assess`

The complexity assessment tool (`cognitive_assess`) uses **pure heuristic rules** (regex pattern matching + weighted scoring). It makes **zero LLM API calls**, so:

- **System 1 tasks** (score < threshold): **0 extra LLM calls** ✅
- **System 2 tasks** (score ≥ threshold): **5–118 extra LLM calls** depending on config

### RPM/TPM Impact Estimates

| Scenario | Config | RPM Risk | TPM/Invocation | Est. Cost (GPT-4o) |
|----------|--------|----------|----------------|---------------------|
| Light (mostly System 1) | any | Low (~1 RPM) | 0 extra tokens | $0 |
| Moderate | balanced | Medium (~15 RPM) | ~5,000 tokens | ~$0.03 |
| Heavy (every msg triggers FLARE) | default | **High (~120 RPM)** | ~70,000 tokens | ~$0.50 |

### Optimization Recommendations

1. **Start with the `balanced` preset** — good planning quality at ~13 LLM calls
2. **Raise the threshold** to 0.70–0.80 to reduce FLARE trigger frequency
3. **Use `/cogtune`** to monitor and adjust in real-time
4. **Watch for 429 rate-limit errors** — if hit, lower depth/branch immediately

## Architecture

```
User Input
    │
    ▼
agent:bootstrap → Inject Cognitive Routing Protocol
    │
    ▼
cognitive_assess → 6-dimension complexity scoring (zero LLM calls)
    │
    ├── score < threshold → SYSTEM_1 (direct response)
    │
    └── score ≥ threshold → SYSTEM_2 → flare_plan
                                          │
                                          ▼
                                  Build Search Tree (UCB)
                                          │
                                     ┌────┴────┐
                                  generateAction  simulateState
                                  Candidates()    Transition()
                                     └────┬────┘
                                          ▼
                                Backward Value Propagation
                                          │
                                          ▼
                                Execute Best First Action
                                          │
                                          ▼
                            tool_result_persist → Clear Hypotheses → Re-plan
```

## Requirements

- **Node.js** ≥ 22
- **OpenClaw** ≥ 2025.0.0

## License

MIT
