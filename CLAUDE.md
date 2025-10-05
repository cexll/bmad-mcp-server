# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BMAD-MCP is an MCP (Model Context Protocol) server that orchestrates a complete agile development workflow: **PO → Architect → SM → Dev → Review → QA**. It manages workflow state, dispatches role prompts, and saves artifacts but **does NOT call LLMs directly** - that's Claude Code's responsibility.

## Build & Development Commands

```bash
# Build the project
npm run build

# Development with watch mode
npm run dev

# Run the compiled server (for manual testing)
npm start

# Test MCP server locally (outputs to stdio)
node dist/index.js
```

## Installation & Setup

```bash
# After building, link globally
npm link

# Add to Claude Code
claude mcp add-json --scope user bmad '{"type":"stdio","command":"bmad-mcp"}'

# Verify installation
which bmad-mcp
bmad-mcp  # Should output: BMAD MCP Server running on stdio
```

## Architecture

### Two-File Architecture

The codebase has a simple, focused architecture:

1. **`src/master-prompt.ts`** - Master orchestrator containing:
   - All role prompts for 6 workflow stages (PO, Architect, SM, Dev, Review, QA)
   - Workflow definition and engine configuration
   - Quality gate thresholds
   - Stage descriptions and context builders
   - **This is the single source of truth for workflow logic**

2. **`src/index.ts`** - MCP server implementation:
   - State machine for session management
   - Content reference system (saves large content to files, stores references)
   - Score extraction and quality assessment
   - Clarification question workflow
   - Tool handlers for start/submit/answer/confirm/approve/status actions

### State Machine Flow

The workflow uses a state machine with these states:

- `generating` - Initial generation phase, awaiting first submission
- `clarifying` - Waiting for user to answer clarification questions (PO/Architect only)
- `refining` - Refining based on user answers or regenerating with improvements
- `awaiting_confirmation` - **NEW**: Unified state for score ≥90, one-step save + approve
- `awaiting_approval` - Waiting for user approval to proceed to next stage (SM only)
- `completed` - Workflow finished

**Key architectural decision**: `awaiting_confirmation` replaces the old two-step process (`awaiting_save_confirmation` → `awaiting_approval`) with a single `confirm` action that both saves and advances stages.

### Engine Configuration by Stage

| Stage | Engines | Purpose | Dynamic Selection |
|-------|---------|---------|-------------------|
| PO | claude + codex | Both generate PRD, results are merged | If objective contains "codex", uses both; else Claude only |
| Architect | claude + codex | Both generate architecture, results are merged | Same as PO |
| SM | claude | Sprint planning (Claude only) | Always Claude |
| Dev | codex | Code implementation (Codex only) | Always Codex |
| Review | codex | Code review (Codex only) | Always Codex |
| QA | codex | Testing (Codex only) | Always Codex |

**Implementation note**: `getEnginesForStage()` in index.ts:115-122 checks if the objective contains "codex" or "使用 codex" to enable dual-engine mode for PO/Architect stages.

### Content Reference System (Token Optimization)

To avoid bloating session JSON files with large LLM outputs, the server uses a **content reference system**:

- Large content (PRD, architecture docs) is saved to `.bmad-task/temp/{session_id}/`
- Session state stores only `ContentReference` objects with:
  - `summary`: First 300 characters
  - `file_path`: Relative path to full content
  - `size`: File size in bytes
  - `last_updated`: Timestamp
- When full content is needed (e.g., for context in next stage), `readContentFromFile()` loads it

**Implementation**: See `saveContentToFile()` (index.ts:127-152) and `readContentFromFile()` (index.ts:157-160).

### Task Naming & Directory Structure

Sessions are organized by **human-readable task names** instead of UUIDs:

1. **Task slug generation** (index.ts:203-211): Converts `objective` → lowercase, removes special chars, max 50 chars
   - Example: "Build user authentication system" → "build-user-authentication-system"
2. **Uniqueness check** (index.ts:216-232): Appends `-1`, `-2` if task name exists
3. **Task mapping** (index.ts:237-257): Stores in `.bmad-task/task-mapping.json` for lookup

**File Structure**:

**Session State**: `.bmad-task/session-{uuid}.json` - Workflow state with content references

**Task Mapping**: `.bmad-task/task-mapping.json` - Maps session_id → task_name + objective

**Temporary Content**: `.bmad-task/temp/{session_id}/{stage}_{content_type}_{timestamp}.md`

**Artifacts** (final saved docs): `.claude/specs/{task_name}/` (NOT session_id!)
- `01-product-requirements.md` (PO stage)
- `02-system-architecture.md` (Architect stage)
- `03-sprint-plan.md` (SM stage)
- `04-dev-reviewed.md` (Review stage)
- `05-qa-report.md` (QA stage)

## Critical Implementation Details

### Interactive Clarification Workflow

**First Iteration** (PO/Architect stages):
1. Claude/Codex generate initial draft with score < 90
2. They identify 3-5 gaps and generate 3-5 clarification questions
3. Output includes: `prd_draft`, `quality_score`, `gaps[]`, `questions[]`
4. Server enters `clarifying` state

**Subsequent Iterations**:
1. User answers questions via `answer` action
2. Server enters `refining` state, provides role_prompt with `user_answers` context
3. Claude/Codex regenerate with answers incorporated
4. If score ≥ 90 → `awaiting_save_confirmation`, else repeat clarification

### Unified Confirmation Process (Since v0.1.0)

When score ≥ 90 (PO/Architect stages):
1. **State**: `awaiting_confirmation`
2. **Action**: User types `confirm` (or legacy `confirm_save`)
3. **Result**: Artifact is saved AND workflow advances to next stage (one step)

This replaces the old two-step process where users had to:
1. ~~`confirm_save` → saves artifact → `awaiting_approval`~~
2. ~~`approve` → advances to next stage~~

**Code reference**: `confirmSave()` / `confirm()` (index.ts:1284-1455) now automatically advances to next stage after saving.

### Role Prompt Expectations

All role prompts in `src/master-prompt.ts` expect LLMs to return JSON with specific formats:

**PO/Architect First Iteration**:
```json
{
  "prd_draft": "...",
  "quality_score": 75,
  "gaps": ["gap1", "gap2"],
  "questions": [
    {"id": "q1", "question": "...", "context": "..."}
  ]
}
```

**PO/Architect After User Answers**:
```json
{
  "prd_updated": "...",
  "quality_score": 92,
  "ready_for_approval": true
}
```

### Score Extraction Logic

The server extracts quality scores from LLM responses using multiple patterns (index.ts:1521-1581):

**Priority order**:
1. **JSON format**: `"quality_score": 92` (supports whitespace)
2. **Text format**: `Quality Score: 92/100`
3. **Fallback**: Content quality estimation based on sections (60-85 points max)

**Content quality estimation** (when explicit score missing):
- Base: 60 points
- Each required section present: +5 points (Executive Summary, Business Goals, etc.)
- Quantitative metrics present: +5 points
- Acceptance criteria present: +5 points
- **Maximum**: 85 points (forces explicit scoring for ≥90)

**Quality analysis** (when score < 90 after clarification):
- `analyzePRDQuality()` (index.ts:1586-1641) identifies specific gaps
- Checks for missing sections, metrics, acceptance criteria, error scenarios
- Returns actionable improvement suggestions with point values

**Key implementation detail**: Scores ≥90 are required for PO/Architect stages to advance. If both Claude and Codex generate results, the higher-scoring one is selected.

## Common Development Patterns

### Modifying Role Prompts

All role prompts are in `src/master-prompt.ts`. To modify a role's behavior:

1. Edit the prompt in `ROLE_PROMPTS` constant (lines 64-1543)
2. Update workflow definition if changing engines/quality gates (lines 27-59)
3. Run `npm run build`
4. Test with `node dist/index.js`

**Example**: To change PO quality threshold from 90 to 85:
```typescript
quality_gates: {
  po: { min_score: 85, approval_required: true },  // Changed from 90
  ...
}
```

### Adding New Workflow States

If adding new states to the state machine:

1. Update `current_state` type in `WorkflowSession` interface (index.ts:73-79)
2. Add state handling logic in appropriate handlers (`submit`, `answer`, `confirmSave`, `approve`)
3. Update response format to include `requires_user_confirmation` and `interaction_type`
4. Test state transitions thoroughly

### Debugging Session State

Read session files directly for debugging:
```bash
# View session state
cat .bmad-task/session-<uuid>.json | jq .

# View task mapping
cat .bmad-task/task-mapping.json | jq .

# View temporary content
cat .bmad-task/temp/<session_id>/<stage>_final_result_*.md
```

## Common Gotchas

1. **Session Management**: Sessions stored in `.bmad-task/` - ensure project directory has write permissions
2. **Engine Parameters**: When calling Codex MCP for Dev/Review/QA, always use `model: "gpt-5"` (NOT "gpt-5-codex")
3. **State Transitions**: Check `current_state` and `requires_user_confirmation` in responses
4. **Artifact Paths**: Artifacts use `task_name` directory, not `session_id`
5. **Question/Answer Format**: Question IDs must match when submitting answers
6. **Content References**: Session JSON contains references, not full content - use `readContentFromFile()` to load
7. **Unified Confirmation**: `confirm` action both saves and advances (one step, not two)

## MCP Tool Actions

Available actions for `bmad-task` tool:

- `start` - Initialize workflow, returns session_id, task_name, and PO stage prompt
- `submit` - Submit LLM results for current stage (include `claude_result` and/or `codex_result`)
- `answer` - Submit user answers to clarification questions (provide `answers: {questionId: answer}`)
- `confirm` - **NEW**: Confirm and save artifact when score ≥90, automatically advances to next stage
- `confirm_save` - **Legacy alias** for `confirm` (kept for backward compatibility)
- `approve` - Approve current stage to proceed to next (used only for SM stage)
- `status` - Query current workflow status for a session (returns lightweight session data)

## Testing & Debugging

To test changes locally:

```bash
# 1. Make changes to src/
# 2. Rebuild
npm run build

# 3. Test MCP server
node dist/index.js
# Should see: BMAD MCP Server running on stdio
# Ctrl+C to exit

# 4. If linked globally, changes take effect immediately for Claude Code
```

Debug session state by reading `.bmad-task/session-{uuid}.json` files directly.

## Key TypeScript Interfaces

```typescript
interface WorkflowSession {
  session_id: string;
  task_name: string;  // Human-readable slug from objective
  cwd: string;
  objective: string;
  current_stage: "po" | "architect" | "sm" | "dev" | "review" | "qa";
  current_state: "generating" | "clarifying" | "refining"
                 | "awaiting_confirmation" | "awaiting_approval" | "completed";
  stages: Record<Stage, {
    status: "pending" | "in_progress" | "completed";
    // Content stored as references, not full text
    claude_result_ref?: ContentReference;
    codex_result_ref?: ContentReference;
    final_result_ref?: ContentReference;
    // Clarification workflow
    draft?: string;
    questions?: ClarificationQuestion[];
    answers?: Record<string, string>;
    gaps?: string[];
    score?: number;
    approved?: boolean;
    iteration?: number;
  }>;
  artifacts: string[];  // Relative paths to saved artifacts
  created_at: string;
  updated_at: string;
}

interface ContentReference {
  summary: string;        // First 300 chars
  file_path: string;      // Relative to cwd
  size: number;           // Bytes
  last_updated: string;   // ISO timestamp
}

interface ClarificationQuestion {
  id: string;             // e.g., "q1", "q2"
  question: string;
  context?: string;       // Why this question matters
}

interface TaskMapping {
  [sessionId: string]: {
    task_name: string;
    objective: string;
    created_at: string;
  };
}
```

## Integration Pattern with Claude Code

When Claude Code receives a user request to use BMAD:

1. Call `start` action → get session_id, task_name, role_prompt, engines
2. Execute LLM calls based on engines array (claude, codex, or both)
3. Call `submit` action with results (`claude_result` and/or `codex_result`)
4. Check response `current_state` and `requires_user_confirmation`:
   - `clarifying` → Present questions to user, collect answers, call `answer`
   - `refining` → Regenerate based on user answers or improvements
   - `awaiting_confirmation` → Ask user to confirm, call `confirm` (saves + advances)
   - `awaiting_approval` → Ask user to approve (SM stage only), call `approve`
   - `completed` → Workflow finished
5. Repeat until workflow completed

**Critical**: Always check `requires_user_confirmation: true` and wait for user input before proceeding.

### Special Handling for Dev Stage

When entering the Dev stage (after SM approval), the workflow requires explicit user instruction for sprint scope:

1. **Display Sprint Information**: Show the list of sprints extracted from Sprint Plan
2. **Wait for User Instruction**: Do NOT automatically start development
3. **Default Behavior**: Unless user specifies a particular sprint, assume they want to implement **all sprints** in one go
4. **User Intent Recognition**:
   - "开始开发" / "start development" / "implement" → Implement ALL sprints
   - "开发Sprint 1" / "implement sprint 1" → Implement only Sprint 1
   - "implement all sprints" → Explicitly implement all sprints

**Example Flow**:
```
bmad-task approve → enters dev stage
↓
User sees: "Sprint Plan 包含 3 个 Sprint"
↓
User says: "开始开发" (generic instruction)
↓
Claude Code interprets: Implement all 3 sprints (default behavior)
↓
Call Codex MCP with context for all sprints
```

**Important**: The `pending_user_actions` field will be `["specify_sprint_scope_then_generate"]` for dev stage, indicating that user must specify scope before generation.

---

## BMAD Task 交互规则（CRITICAL - 覆盖全局 Auto-Confirmation）

**重要**：bmad-task 是交互式工作流，**禁止自动执行任何操作**。

### 强制规则（优先级最高）

1. ❌ **严格禁止**自动调用 `bmad-task` 的 `submit`/`confirm_save`/`approve` 动作
2. ✅ **必须**先将生成的内容完整展示给用户审查
3. ✅ **必须**等待用户明确指令（如 "confirm save", "approve"）才能继续
4. ✅ **必须**在每个阶段暂停，询问用户意见

### 识别标志

如果 bmad-task 响应包含以下**任一标志**，**立即暂停并等待用户**：

- `requires_user_confirmation: true`
- `interaction_type: "user_decision"`
- `interaction_type: "awaiting_generation"`
- `interaction_type: "awaiting_regeneration"`
- `state: "clarifying"`
- `state: "awaiting_confirmation"`
- `state: "awaiting_approval"`

### 正确交互流程

```
阶段 1: 启动工作流
├─ bmad-task start
├─ 展示 role_prompt 和任务信息
└─ 等待用户确认 → "好的，开始生成 PRD"

阶段 2: 生成内容
├─ 使用 Claude/Codex 生成内容
├─ **完整展示**生成的内容给用户
└─ 等待用户审查 → "满意，提交吧" / "需要修改..."

阶段 3: 提交结果
├─ bmad-task submit
├─ 展示评分和反馈（如有问题，展示问题列表）
└─ 等待用户操作 → "回答问题" / "满意，确认"

阶段 4a: 如需澄清 (score < 90 且有问题)
├─ 用户回答问题
├─ bmad-task answer
├─ 基于答案重新生成
└─ 返回阶段 3

阶段 4b: 确认保存并进入下一阶段 (score ≥ 90)
├─ 用户输入 "confirm" (或 "confirm save")
├─ bmad-task confirm
├─ **一步完成**：保存文档 + 进入下一阶段
└─ 展示下一阶段信息

阶段 5: 循环
└─ 回到阶段 2（直到所有阶段完成）
```

**注意**: 新版本使用 `confirm` 一步完成保存和进入下一阶段，不再需要分两步 `confirm_save` 然后 `approve`。

### 响应格式说明

bmad-task 的响应格式已优化为**用户友好**格式：

**当前格式**：
```json
{
  "requires_user_confirmation": true,
  "interaction_type": "user_decision",
  "user_message": "⚠️ **请审查...**\n\n下一步操作：\n- 如满意，请输入：confirm\n...",
  "pending_user_actions": ["confirm", "reject"]
}
```

### 关键字段

| 字段 | 含义 | Claude Code 应该如何处理 |
|------|------|------------------------|
| `requires_user_confirmation` | 是否需要用户确认 | true 时**必须**等待用户输入 |
| `interaction_type` | 交互类型 | 用于判断当前阶段 |
| `user_message` | 给用户的提示信息 | **完整展示**给用户 |
| `pending_user_actions` | 等待用户选择的动作 | 展示给用户，**等待用户输入** |
| `current_state` | 当前状态 | 用于追踪工作流进度 |

### 反例（禁止的行为）

❌ **错误示例 1：自动提交**
```
User: 使用 bmad-task 创建项目
Claude Code:
1. 调用 bmad-task start
2. 生成 PRD
3. 立即调用 bmad-task submit  ← 错误！未给用户看
```

❌ **错误示例 2：自动确认**
```
Claude Code:
1. bmad-task submit → 返回 awaiting_confirmation
2. 立即调用 bmad-task confirm  ← 错误！未等用户确认
```

✅ **正确示例：交互式流程**
```
User: 使用 bmad-task 创建项目
Claude Code:
1. 调用 bmad-task start
2. 展示：「我将生成 PRD，使用 Claude 和 Codex...」
3. 等待用户：「User: 好的，开始吧」
4. 生成 PRD
5. 展示：「以下是生成的 PRD...（完整内容）...是否满意？」
6. 等待用户：「User: 满意，提交吧」
7. 调用 bmad-task submit
8. 展示：「评分 95/100，是否确认保存并进入下一阶段？」
9. 等待用户：「User: confirm」
10. 调用 bmad-task confirm → 一步完成保存和进入下一阶段
... (循环)
```

### Debug 检查点

如果 bmad-task 被自动调用，检查以下问题：

1. Claude Code 是否忽略了 `requires_user_confirmation: true` 标志？
2. Claude Code 是否将 `pending_user_actions` 理解为 `next_action`？
3. Claude Code 的全局 CLAUDE.md 是否有 "Auto-Confirmation" 规则覆盖了本规则？
4. 是否展示了 `user_message` 的完整内容给用户？

### 故障排查

如果 bmad-task 仍然自动执行：

1. 检查 `~/.claude/CLAUDE.md`（全局配置）是否有冲突规则
2. 检查 bmad-task 响应中是否包含 `requires_user_confirmation: true`
3. 在 Claude Code 中添加断点：检查是否读取了本 CLAUDE.md
4. 验证 bmad-task 版本：`npm ls bmad-mcp`

