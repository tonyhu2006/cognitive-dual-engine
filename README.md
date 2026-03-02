# cognitive-dual-engine

An [OpenClaw](https://openclaw.ai/) plugin that implements **System 1 / System 2 cognitive routing** for AI agents, powered by the **FLARE** (Future-aware LookAhead with Reward Estimation) planning framework.

## What it does

Before the AI agent acts on any task, this plugin injects a **meta-cognition layer** that:

1. **Assesses task complexity** across 6 dimensions (logical depth, tool dependency, ambiguity, cross-domain complexity, state dependency, latency tolerance)
2. **Routes to the optimal processing path:**
   - **System 1 (Intuition)** — Simple tasks: fast, direct LLM generation
   - **System 2 (FLARE Planning)** — Complex tasks: lookahead tree search with backward value propagation and limited commitment planning

## Academic foundations

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

| Parameter | Default | Description |
|-----------|---------|-------------|
| `system2Threshold` | `0.55` | Complexity score threshold for System 2 activation |
| `flareMaxDepth` | `3` | Maximum search tree depth |
| `flareBranchFactor` | `3` | Candidate actions per node |
| `flareSimulationsPerNode` | `2` | Monte Carlo simulations per expansion |

## Usage

Once installed, the plugin works **automatically**:

- The `agent:bootstrap` hook injects routing instructions into the agent's system prompt
- The agent calls `cognitive_assess` before every task
- Complex tasks automatically trigger `flare_plan` for optimized planning
- The `tool_result_persist` hook enforces **limited commitment** — clearing stale hypotheses after each action

### Commands

- `/cogstatus` — View current cognitive routing state (complexity score, routing tag, plan step count)

## Architecture

```
User Input
    │
    ▼
agent:bootstrap → Inject Cognitive Routing Protocol
    │
    ▼
cognitive_assess → 6-dimension complexity scoring
    │
    ├── score < 0.55 → SYSTEM_1 (direct response)
    │
    └── score ≥ 0.55 → SYSTEM_2 → flare_plan
                                      │
                                      ▼
                              Build Search Tree (UCB)
                                      │
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
