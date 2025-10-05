#!/usr/bin/env node

/**
 * BMAD MCP Server
 *
 * Lightweight workflow orchestrator that:
 * 1. Manages workflow state (which stage, what's needed)
 * 2. Dispatches role prompts to Claude Code
 * 3. Saves artifacts (PRD, architecture, etc.)
 * 4. Does NOT call LLMs directly - that's Claude Code's job
 *
 * Reference: https://github.com/modelcontextprotocol/servers/blob/main/src/sequentialthinking/index.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  WORKFLOW_DEFINITION,
  ROLE_PROMPTS,
  STAGE_DESCRIPTIONS,
  getStageContext,
  type WorkflowStage,
  type EngineType,
} from "./master-prompt.js";

/**
 * 澄清问题数据结构
 */
interface ClarificationQuestion {
  id: string;
  question: string;
  context?: string;
}

/**
 * 内容引用结构（用于替代完整内容，节省token）
 */
interface ContentReference {
  summary: string;        // 前200字符摘要
  file_path: string;      // 完整内容文件路径（相对路径）
  size: number;           // 内容大小（字节）
  last_updated: string;   // 最后更新时间
}

/**
 * Task映射结构
 */
interface TaskMapping {
  [sessionId: string]: {
    task_name: string;
    objective: string;
    created_at: string;
  };
}

/**
 * Session 数据结构
 */
interface WorkflowSession {
  session_id: string;
  task_name: string;          // 新增：从objective生成的任务名称slug
  cwd: string;
  objective: string;
  current_stage: WorkflowStage;
  current_state:
    | "generating"
    | "clarifying"              // 新增：等待用户回答澄清问题
    | "refining"
    | "awaiting_confirmation"       // 统一：等待用户一次性确认（保存+进入下一阶段）
    | "awaiting_approval"
    | "completed";
  stages: Record<
    WorkflowStage,
    {
      status: "pending" | "in_progress" | "completed";
      // 修改：用引用替代完整内容
      claude_result_ref?: ContentReference;
      codex_result_ref?: ContentReference;
      final_result_ref?: ContentReference;
      score?: number;
      approved?: boolean;
      iteration?: number;
      // 新增字段：需求澄清相关
      draft?: string;                           // 未保存的草稿
      questions?: ClarificationQuestion[];      // 澄清问题列表
      answers?: Record<string, string>;         // 用户回答
      gaps?: string[];                          // 识别的空白点
    }
  >;
  artifacts: string[];
  created_at: string;
  updated_at: string;
}

/**
 * BMAD Workflow Server
 */
class BmadWorkflowServer {
  private sessions: Map<string, WorkflowSession> = new Map();

  /**
   * 各阶段可能的内容字段（优先级从高到低）
   */
  private readonly STAGE_CONTENT_FIELDS: Record<string, string[]> = {
    po: ["prd_draft", "prd_updated"],
    architect: ["architecture_draft", "architecture_updated"],
    sm: ["sprint_plan", "sprint_plan_updated", "plan", "plan_updated"],
    dev: ["implementation", "code", "dev_result"],
    review: ["review", "review_result", "code_review"],
    qa: ["qa_report", "test_report", "qa_result"],
    common: ["draft", "result", "content"],
  };

  /**
   * 根据 objective 决定是否启用 Codex（仅对 PO/Architect 阶段）
   */
  private getEnginesForStage(
    session: WorkflowSession,
    stage: WorkflowStage
  ): EngineType[] {
    if (stage === "po" || stage === "architect") {
      const obj = session.objective || "";
      const useCodex = /codex|使用\s*codex/i.test(obj);
      return useCodex ? ["claude", "codex"] : ["claude"];
    }
    return WORKFLOW_DEFINITION.engines[stage];
  }

  /**
   * 保存大文本内容到临时文件，返回引用
   */
  private saveContentToFile(
    sessionId: string,
    cwd: string,
    contentType: string,  // e.g., "claude_result", "codex_result", "final_result"
    stage: WorkflowStage,
    content: string
  ): ContentReference {
    const tempDir = path.join(cwd, ".bmad-task", "temp", sessionId);

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${stage}_${contentType}_${timestamp}.md`;
    const filePath = path.join(tempDir, filename);

    fs.writeFileSync(filePath, content, "utf-8");

    return {
      summary: content.substring(0, 200) + (content.length > 200 ? "..." : ""),
      file_path: path.relative(cwd, filePath),
      size: Buffer.byteLength(content, "utf-8"),
      last_updated: new Date().toISOString()
    };
  }

  /**
   * 保存任意内容到文件并返回引用（通用方法）
   */
  private saveContentReference(
    sessionId: string,
    cwd: string,
    contentType: string,  // "questions", "gaps", "user_message", "draft", "user_answers" 等
    stage: WorkflowStage,
    content: any,  // string 或 object/array
    extension: string = "json"
  ): ContentReference {
    const tempDir = path.join(cwd, ".bmad-task", "temp", sessionId);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${contentType}-${stage}-${timestamp}.${extension}`;
    const filePath = path.join(tempDir, filename);

    const fileContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(filePath, fileContent, "utf-8");

    return {
      summary: this.generateSummary(content),
      file_path: path.relative(cwd, filePath),
      size: Buffer.byteLength(fileContent, "utf-8"),
      last_updated: new Date().toISOString(),
    };
  }

  /**
   * 生成内容摘要
   */
  private generateSummary(content: any): string {
    if (typeof content === "string") {
      return content.substring(0, 200) + (content.length > 200 ? "..." : "");
    } else if (Array.isArray(content)) {
      return `${content.length} items`;
    } else if (typeof content === "object" && content !== null) {
      const keys = Object.keys(content);
      return `${keys.length} fields: ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? "..." : ""}`;
    }
    const s = String(content ?? "");
    return s.substring(0, 200) + (s.length > 200 ? "..." : "");
  }

  /**
   * 裁剪文本到指定长度（默认 2000 字符）
   */
  private trimText(text: string, maxChars: number = 2000): string {
    if (!text) return text;
    if (text.length <= maxChars) return text;
    return (
      text.substring(0, maxChars) +
      "\n\n...(内容过长，已截断；完整内容请查看相应文件引用或上下文)"
    );
  }

  /**
   * 裁剪澄清问题列表字段，控制每项大小
   */
  private trimQuestions(questions: ClarificationQuestion[] = []): ClarificationQuestion[] {
    return (questions || []).map((q) => ({
      id: q.id,
      question:
        q.question.length > 150 ? q.question.substring(0, 150) + "..." : q.question,
      context: q.context
        ? q.context.length > 200
          ? q.context.substring(0, 200) + "..."
          : q.context
        : undefined,
    }));
  }

  /**
   * 估算 token 数（4 字符 ≈ 1 token）
   */
  private estimateTokensFromString(s: string): number {
    if (!s) return 0;
    return Math.ceil(s.length / 4);
  }

  /**
   * 从引用读取完整内容
   */
  private readContentFromFile(cwd: string, ref: ContentReference): string {
    const filePath = path.join(cwd, ref.file_path);
    return fs.readFileSync(filePath, "utf-8");
  }

  /**
   * 获取轻量级Session（用于status和approve返回，节省token）
   */
  private getLightweightSession(session: WorkflowSession): any {
    return {
      session_id: session.session_id,
      task_name: session.task_name,
      current_stage: session.current_stage,
      current_state: session.current_state,
      objective: session.objective,

      // 只返回状态和分数，不返回完整内容
      stages: Object.fromEntries(
        Object.entries(session.stages).map(([stage, data]) => [
          stage,
          {
            status: data.status,
            score: data.score,
            approved: data.approved,
            iteration: data.iteration,
            // 只返回引用信息，不返回完整内容
            has_claude_result: !!data.claude_result_ref,
            has_codex_result: !!data.codex_result_ref,
            has_final_result: !!data.final_result_ref,
            // 问题列表保留（通常不大）
            questions_count: data.questions?.length || 0,
            gaps_count: data.gaps?.length || 0
          }
        ])
      ),

      artifacts: session.artifacts,
      created_at: session.created_at,
      updated_at: session.updated_at
    };
  }

  /**
   * 从objective生成task slug
   * 例如："Build a user authentication system with JWT" → "build-user-authentication-system"
   */
  private generateTaskSlug(objective: string): string {
    return objective
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')       // 移除特殊字符
      .trim()
      .replace(/\s+/g, '-')           // 空格转-
      .replace(/-+/g, '-')            // 多个-合并
      .substring(0, 50);              // 限制长度
  }

  /**
   * 确保task名称唯一（如果已存在则添加数字后缀）
   */
  private ensureUniqueTaskName(cwd: string, baseName: string): string {
    const specsDir = path.join(cwd, ".claude", "specs");

    if (!fs.existsSync(specsDir)) {
      return baseName;
    }

    let taskName = baseName;
    let counter = 1;

    while (fs.existsSync(path.join(specsDir, taskName))) {
      taskName = `${baseName}-${counter}`;
      counter++;
    }

    return taskName;
  }

  /**
   * 保存task映射
   */
  private saveTaskMapping(cwd: string, sessionId: string, taskName: string, objective: string): void {
    const mappingDir = path.join(cwd, ".bmad-task");
    const mappingPath = path.join(mappingDir, "task-mapping.json");

    if (!fs.existsSync(mappingDir)) {
      fs.mkdirSync(mappingDir, { recursive: true });
    }

    let mapping: TaskMapping = {};
    if (fs.existsSync(mappingPath)) {
      mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));
    }

    mapping[sessionId] = {
      task_name: taskName,
      objective: objective,
      created_at: new Date().toISOString()
    };

    fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), "utf-8");
  }

  /**
   * 启动新的工作流
   */
  public start(input: {
    cwd: string;
    objective: string;
  }): { content: Array<{ type: string; text: string }> } {
    const sessionId = randomUUID();

    // 生成task name
    const baseTaskName = this.generateTaskSlug(input.objective);
    const taskName = this.ensureUniqueTaskName(input.cwd, baseTaskName);

    // 初始化 session
    const session: WorkflowSession = {
      session_id: sessionId,
      task_name: taskName,
      cwd: input.cwd,
      objective: input.objective,
      current_stage: "po",
      current_state: "generating",
      stages: {
        po: { status: "in_progress", iteration: 1 },
        architect: { status: "pending" },
        sm: { status: "pending" },
        dev: { status: "pending" },
        review: { status: "pending" },
        qa: { status: "pending" },
      },
      artifacts: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.sessions.set(sessionId, session);

    // 保存 session 到文件
    this.saveSession(session);

    // 保存task映射
    this.saveTaskMapping(input.cwd, sessionId, taskName, input.objective);

    // 获取 PO 阶段的上下文
    const stageContext = getStageContext("po");
    // 动态选择引擎：默认仅 Claude，objective 明确包含 codex 时启用 Codex
    const engines = this.getEnginesForStage(session, "po");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              session_id: sessionId,
              task_name: taskName,
              stage: "po",
              state: "generating",
              stage_description: STAGE_DESCRIPTIONS.po,

              // 明确表示需要用户参与
              requires_user_confirmation: true,
              interaction_type: "awaiting_generation",

              // 用户友好的提示信息
              user_message: `📋 **BMAD 工作流已启动**

当前阶段：Product Owner (PO)
任务：${input.objective}
Session ID: ${sessionId}
Task Name: ${taskName}

**下一步操作**：
1. 我将使用 ${engines.join(" 和 ")} 生成产品需求文档 (PRD)（默认仅 Claude；只有 objective 明确包含“codex/使用codex”才会启用 Codex）
2. 生成后，我会展示给你审查
3. 你只需一次 “confirm” 确认，即可保存并进入下一阶段（兼容旧指令：confirm_save）

⚠️ 请注意：我不会自动提交，需要你明确指示。`,

              // 技术信息（供 Claude Code 使用）
              role_prompt: stageContext.role_prompt,
              engines,
              context: {
                objective: input.objective,
              },

              // 改为 pending_user_actions（而非 next_action）
              pending_user_actions: ["review_and_confirm_generation"],
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * 提交阶段结果
   */
  public submit(input: {
    session_id: string;
    stage: WorkflowStage;
    claude_result?: string;
    codex_result?: string;
  }): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    const session = this.sessions.get(input.session_id);
    if (!session) {
      return this.errorResponse("Session not found");
    }

    const stageData = session.stages[input.stage];

    // 存储结果为引用（保存到临时文件）
    if (input.claude_result) {
      stageData.claude_result_ref = this.saveContentToFile(
        input.session_id,
        session.cwd,
        "claude_result",
        input.stage,
        input.claude_result
      );
    }
    if (input.codex_result) {
      stageData.codex_result_ref = this.saveContentToFile(
        input.session_id,
        session.cwd,
        "codex_result",
        input.stage,
        input.codex_result
      );
    }

    // 保存session（包含引用）
    this.saveSession(session);

    // 根据阶段处理结果（传递完整内容用于分析）
    if (input.stage === "po" || input.stage === "architect") {
      // PO/Architect: 合并两个方案
      return this.handleDualEngineStage(
        session,
        input.stage,
        input.claude_result,
        input.codex_result
      );
    } else if (input.stage === "sm") {
      // SM: 只有 Claude 结果
      return this.handleSingleEngineStage(session, input.stage, input.claude_result!);
    } else {
      // Dev/Review/QA: 只有 Codex 结果
      return this.handleSingleEngineStage(session, input.stage, input.codex_result!);
    }
  }

  /**
   * 处理双引擎阶段（PO/Architect）
   */
  private handleDualEngineStage(
    session: WorkflowSession,
    stage: WorkflowStage,
    claudeResult?: string,
    codexResult?: string
  ): { content: Array<{ type: string; text: string }> } {
    const stageData = session.stages[stage];
    const dynEngines = this.getEnginesForStage(session, stage);

    // 评分（使用传入的内容）
    const claudeScore = this.scoreContent(claudeResult || "");
    const codexScore = this.scoreContent(codexResult || "");

    // 提取问题和空白点
    const claudeQuestions = this.extractQuestions(claudeResult || "");
    const codexQuestions = this.extractQuestions(codexResult || "");
    const claudeGaps = this.extractGaps(claudeResult || "");
    const codexGaps = this.extractGaps(codexResult || "");

    // 合并问题和空白点
    const mergedQuestions = this.mergeQuestions(claudeQuestions, codexQuestions);
    const mergedGaps = Array.from(new Set([...claudeGaps, ...codexGaps]));

    // 检查是否是首次分析（iteration === 1 且没有用户回答）
    const isInitialAnalysis = (stageData.iteration || 1) === 1 && !stageData.answers;

    // 如果是首次分析且有问题，进入 clarifying 状态
    if (isInitialAnalysis && mergedQuestions.length > 0) {
      // 提取草稿（选择更高分的）
      const draftSource =
        claudeScore >= codexScore ? claudeResult : codexResult;
      const draft = this.extractDraft(draftSource || "");

      stageData.draft = draft;
      stageData.questions = mergedQuestions;
      stageData.gaps = mergedGaps;
      stageData.score = Math.max(claudeScore, codexScore);

      session.current_state = "clarifying";
      this.saveSession(session);

      // 保存大文本内容到文件（文件引用方案）
      const questionsRef = this.saveContentReference(
        session.session_id,
        session.cwd,
        "questions",
        stage,
        mergedQuestions,
        "json"
      );

      const gapsRef = this.saveContentReference(
        session.session_id,
        session.cwd,
        "gaps",
        stage,
        mergedGaps,
        "json"
      );

      const draftRef = this.saveContentReference(
        session.session_id,
        session.cwd,
        "draft",
        stage,
        draft,
        "md"
      );

      // 生成完整 user_message（必要信息 -> 文件引用）
      const fullUserMessage = `⚠️ **【需要用户输入，禁止自动回答】**

🔍 需求澄清 - ${STAGE_DESCRIPTIONS[stage]}
初步分析完成，得分：${stageData.score}/100

**识别的空白点**：
详见文件：${gapsRef.file_path}

**需要你回答的问题**：
详见文件：${questionsRef.file_path}

**草稿内容**：
详见文件：${draftRef.file_path}

---
回答方式：
\`\`\`
bmad-task action=answer session_id=${session.session_id} answers={"q1":"...","q2":"..."}
\`\`\`

⚠️ **【重要】请用户亲自回答上述问题，AI 不应自动编造答案。**`;

      // 如果过长，写入文件，仅返回引用
      const userMessageRef = fullUserMessage.length > 1000
        ? this.saveContentReference(
            session.session_id,
            session.cwd,
            "user_message",
            stage,
            fullUserMessage,
            "md"
          )
        : null;

      const payload = {
        session_id: session.session_id,
        stage,
        state: "clarifying",
        current_score: stageData.score,

        // 明确表示需要用户参与
        requires_user_confirmation: true,
        interaction_type: "user_decision",
        // 显式禁止自动执行（强制等待）
        STOP_AUTO_EXECUTION: true,
        must_wait_for_user: true,

        // 用户消息：内联或引用
        user_message: userMessageRef
          ? `📄 完整说明见文件：${userMessageRef.file_path}\n\n摘要：${userMessageRef.summary}`
          : fullUserMessage,

        // 文件引用（主要信息）
        questions_ref: questionsRef,
        gaps_ref: gapsRef,
        draft_ref: draftRef,
        user_message_ref: userMessageRef,

        // 保留简短内联版本（兼容性）
        questions_count: mergedQuestions.length,
        gaps_count: mergedGaps.length,
        questions_summary: `${mergedQuestions.length} questions: ${mergedQuestions.slice(0, 2).map(q => q.id).join(", ")}${mergedQuestions.length > 2 ? "..." : ""}`,
        gaps_summary: `${mergedGaps.length} gaps identified`,
        scores: {
          claude: claudeScore,
          codex: codexScore,
        },

        // 改为 pending_user_actions
        pending_user_actions: ["answer_questions", "confirm_draft"],
      };

      const text = JSON.stringify(payload, null, 2);
      console.error(`[DEBUG] Response size: ${this.estimateTokensFromString(text)} tokens (with file references)`);
      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };
    }

    // 合并策略
    let finalResult: string;
    let finalScore: number;

    if (claudeScore >= 90 && codexScore >= 90) {
      // 都达标，选更高分
      if (claudeScore >= codexScore) {
        finalResult = claudeResult!;
        finalScore = claudeScore;
      } else {
        finalResult = codexResult!;
        finalScore = codexScore;
      }
    } else if (claudeScore >= 90) {
      finalResult = claudeResult!;
      finalScore = claudeScore;
    } else if (codexScore >= 90) {
      finalResult = codexResult!;
      finalScore = codexScore;
    } else {
      // 都不达标，选择更高分的继续优化
      const bestScore = Math.max(claudeScore, codexScore);
      finalResult =
        claudeScore >= codexScore
          ? claudeResult!
          : codexResult!;
      finalScore = bestScore;
    }

    // 提取纯 Markdown 内容并直接保存到最终 artifact 路径
    const cleaned = this.extractDraft(finalResult || "");
    const artifactPath = this.saveArtifact(
      session.session_id,
      session.cwd,
      stage,
      cleaned
    );
    stageData.final_result_ref = {
      summary: cleaned.substring(0, 200) + (cleaned.length > 200 ? "..." : ""),
      file_path: artifactPath,
      size: Buffer.byteLength(cleaned, 'utf-8'),
      last_updated: new Date().toISOString()
    };
    stageData.score = finalScore;
    this.saveSession(session);

    if (finalScore >= 90) {
      // 达标，进入统一的 awaiting_confirmation 状态（一次确认：保存+进入下一阶段）
      session.current_state = "awaiting_confirmation";
      this.saveSession(session);

      const stageName = stage === "po" ? "PRD" : "Architecture";

      {
        // 生成完整 user_message
        const fullUserMessage = `✅ **${stageName}生成完成**

质量评分：${finalScore}/100 ✨

**文档信息**：
- 文件路径：${stageData.final_result_ref?.file_path}
- 文件大小：${stageData.final_result_ref?.size} bytes

**评分详情**：
- Claude 方案：${claudeScore}/100
- Codex 方案：${codexScore}/100
- 最终采用：${finalScore}/100

**下一步操作**：
请审查上述文档内容（完整内容见文件：${stageData.final_result_ref?.file_path}）

- 如满意，请输入：confirm
- 如需修改，请输入：reject 并说明原因

⚠️ 我不会自动保存，需要你明确确认。`;

        // 如过长，写入文件
        const userMessageRef = fullUserMessage.length > 1000
          ? this.saveContentReference(
              session.session_id,
              session.cwd,
              "user_message",
              stage,
              fullUserMessage,
              "md"
            )
          : null;

        const payload = {
          session_id: session.session_id,
          stage,
          state: "awaiting_confirmation",
          score: finalScore,

          // 明确表示需要用户确认
          requires_user_confirmation: true,
          interaction_type: "user_decision",

          // 用户消息：内联或引用
          user_message: userMessageRef
            ? `📄 完整说明见文件：${userMessageRef.file_path}`
            : fullUserMessage,

          // 文件引用
          final_draft_ref: stageData.final_result_ref,
          user_message_ref: userMessageRef,

          // 简短内联信息（兼容性）
          score_summary: `${finalScore}/100 (Claude: ${claudeScore}, Codex: ${codexScore})`,
          scores: {
            claude: claudeScore,
            codex: codexScore,
            final: finalScore,
          },

          // 改为 pending_user_actions（新增 confirm，保留 confirm_save 兼容）
          pending_user_actions: ["confirm", "confirm_save", "reject_and_refine"],
        };
        const text = JSON.stringify(payload, null, 2);
        console.error(`[DEBUG] Response size: ${this.estimateTokensFromString(text)} tokens (with file references)`);
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      }
    } else {
      // 未达标，需要重新生成
      const iteration = (stageData.iteration || 1) + 1;
      stageData.iteration = iteration;

      // 🔑 关键修复：检查是否已经澄清过
      const hasBeenClarified = iteration > 2 ||
        (stageData.answers && Object.keys(stageData.answers).length > 0 &&
         Object.values(stageData.answers).some(v => v && typeof v === 'string' && v.trim().length > 0));

      if (hasBeenClarified) {
        // 已澄清但仍未达标 → 读取 PRD 分析具体不足
        let savedContent = finalResult;

        // 尝试从已保存的文件读取完整内容
        if (stageData.final_result_ref?.file_path) {
          try {
            savedContent = fs.readFileSync(stageData.final_result_ref.file_path, 'utf-8');
          } catch (e) {
            // 如果读取失败，使用传入的内容
          }
        }

        const gaps = this.analyzePRDQuality(savedContent, finalScore);

        session.current_state = "refining";
        this.saveSession(session);

        const stageName = stage === "po" ? "PRD" : "Architecture";

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id: session.session_id,
                  stage,
                  state: "refining",
                  current_score: finalScore,
                  iteration,

                  // 明确表示需要用户参与
                  requires_user_confirmation: true,
                  interaction_type: "awaiting_regeneration",

                  // 用户友好的提示信息
                  user_message: `⚠️ **${stageName} 需要改进**

当前评分：${finalScore}/100（未达到 90 分标准）
迭代次数：${iteration}

**具体不足之处**：
${gaps.map((gap, i) => `${i + 1}. ${gap}`).join('\n')}

**下一步操作**：
- 请根据以上建议重新生成 ${stageName}
- 我会使用 ${dynEngines.join(" 和 ")} 重新生成，并再次评分

⚠️ 我不会自动重新生成，需要你明确指示。`,

                  // 技术信息
                  improvement_guidance: gaps,
                  feedback: `Score (${finalScore}/100) below threshold. Specific improvements needed.`,
                  scores: {
                    claude: claudeScore,
                    codex: codexScore,
                  },

                  // 改为 pending_user_actions
                  pending_user_actions: ["regenerate_with_improvements"],
                },
                null,
                2
              ),
            },
          ],
        };
      } else if (mergedQuestions.length > 0) {
        // 首次且有问题 → 正常进入 clarifying
        stageData.draft = finalResult;
        stageData.questions = mergedQuestions;
        stageData.gaps = mergedGaps;

        session.current_state = "clarifying";
        this.saveSession(session);

        // 引用存储：questions/gaps/draft
        const questionsRef = this.saveContentReference(
          session.session_id,
          session.cwd,
          "questions",
          stage,
          mergedQuestions,
          "json"
        );
        const gapsRef = this.saveContentReference(
          session.session_id,
          session.cwd,
          "gaps",
          stage,
          mergedGaps,
          "json"
        );
        const draftRef = this.saveContentReference(
          session.session_id,
          session.cwd,
          "draft",
          stage,
          finalResult,
          "md"
        );

        const fullUserMessage = `⚠️ **【需要用户输入，禁止自动回答】**

⚠️ 需要改进 - ${STAGE_DESCRIPTIONS[stage]}
当前评分：${finalScore}/100（未达到 90 分标准）
迭代次数：${iteration}

**识别的空白点**：
详见文件：${gapsRef.file_path}

**需要你回答的问题**：
详见文件：${questionsRef.file_path}

**草稿内容**：
详见文件：${draftRef.file_path}

---
回答方式：
\`\`\`
bmad-task action=answer session_id=${session.session_id} answers={"q1":"...","q2":"..."}
\`\`\`

⚠️ **【重要】请用户亲自回答上述问题，AI 不应自动编造答案。**`;

        const userMessageRef = fullUserMessage.length > 1000
          ? this.saveContentReference(
              session.session_id,
              session.cwd,
              "user_message",
              stage,
              fullUserMessage,
              "md"
            )
          : null;

        const payload = {
          session_id: session.session_id,
          stage,
          state: "clarifying",
          current_score: finalScore,
          iteration,

          // 明确表示需要用户参与
          requires_user_confirmation: true,
          interaction_type: "user_decision",
          // 显式禁止自动执行（强制等待）
          STOP_AUTO_EXECUTION: true,
          must_wait_for_user: true,

          // 用户消息：内联或引用
          user_message: userMessageRef
            ? `📄 完整说明见文件：${userMessageRef.file_path}\n\n摘要：${userMessageRef.summary}`
            : fullUserMessage,

          // 文件引用
          questions_ref: questionsRef,
          gaps_ref: gapsRef,
          draft_ref: draftRef,
          user_message_ref: userMessageRef,

          // 向后兼容摘要
          questions_count: mergedQuestions.length,
          gaps_count: mergedGaps.length,
          questions_summary: `${mergedQuestions.length} questions: ${mergedQuestions.slice(0, 2).map(q => q.id).join(", ")}${mergedQuestions.length > 2 ? "..." : ""}`,
          gaps_summary: `${mergedGaps.length} gaps identified`,
          feedback: `Score (${finalScore}/100) below threshold. Please answer questions to refine.`,
          scores: {
            claude: claudeScore,
            codex: codexScore,
          },

          // 改为 pending_user_actions
          pending_user_actions: ["answer_questions"],
        };
        const text = JSON.stringify(payload, null, 2);
        console.error(`[DEBUG] Response size: ${this.estimateTokensFromString(text)} tokens (with file references)`);
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      } else {
        // 首次且没有问题，直接要求重新生成
        session.current_state = "refining";
        this.saveSession(session);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id: session.session_id,
                  stage,
                  state: "refining",
                  current_score: finalScore,
                  iteration,

                  // 明确表示需要用户参与
                  requires_user_confirmation: true,
                  interaction_type: "awaiting_regeneration",

                  // 用户友好的提示信息
                  user_message: `🔄 **需要重新生成 - ${STAGE_DESCRIPTIONS[stage]}**

当前评分：${finalScore}/100（未达到 90 分标准）
迭代次数：${iteration}

反馈：分数低于阈值，建议重新生成以改进质量。

**评分详情**：
- Claude 方案：${claudeScore}/100
- Codex 方案：${codexScore}/100

**下一步操作**：
- 我将使用 ${dynEngines.join(" 和 ")} 重新生成文档
- 生成后会再次评分并展示给你

⚠️ 我不会自动重新生成，需要你明确指示。`,

                  // 技术信息
                  feedback: `Score (${finalScore}/100) below threshold. Please regenerate with improvements.`,
                  scores: {
                    claude: claudeScore,
                    codex: codexScore,
                  },

                  // 改为 pending_user_actions
                  pending_user_actions: ["regenerate_with_improvements"],
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  }

  /**
   * 处理单引擎阶段（SM/Dev/Review/QA）
   */
  private handleSingleEngineStage(
    session: WorkflowSession,
    stage: WorkflowStage,
    result: string
  ): { content: Array<{ type: string; text: string }> } {
    const stageData = session.stages[stage];

    // 保存结果为引用
    stageData.final_result_ref = this.saveContentToFile(
      session.session_id,
      session.cwd,
      "final_result",
      stage,
      result
    );

    // 保存 artifact
    const artifactPath = this.saveArtifact(
      session.session_id,
      session.cwd,
      stage,
      result
    );

    session.artifacts.push(artifactPath);
    stageData.status = "completed";

    if (stage === "sm") {
      // SM 需要批准
      session.current_state = "awaiting_approval";
      this.saveSession(session);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session_id: session.session_id,
                stage,
                state: "awaiting_approval",
                artifact_path: artifactPath,

                // 明确表示需要用户批准
                requires_user_confirmation: true,
                interaction_type: "user_decision",

                // 用户友好的提示信息
                user_message: `✅ **${STAGE_DESCRIPTIONS[stage]} 完成**

Sprint Plan 已生成并保存：${artifactPath}

**下一步操作**：
- 如满意当前阶段成果，请输入：approve（批准进入下一阶段）
- 如需修改，请输入：reject 并说明原因

⚠️ 我不会自动批准，需要你明确确认。`,

                // 改为 pending_user_actions
                pending_user_actions: ["approve_to_next_stage", "reject_and_refine"],
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      // Dev/Review/QA 自动进入下一阶段
      const nextStage = this.getNextStage(stage);
      if (nextStage) {
        session.current_stage = nextStage;
        session.current_state = "generating";
        session.stages[nextStage].status = "in_progress";
        this.saveSession(session);

        const stageContext = getStageContext(nextStage);
        const nextEngines = this.getEnginesForStage(session, nextStage);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id: session.session_id,
                  stage: nextStage,
                  state: "generating",
                  stage_description: STAGE_DESCRIPTIONS[nextStage],

                  // 明确表示需要用户参与
                  requires_user_confirmation: true,
                  interaction_type: "awaiting_generation",

                  // 用户友好的提示信息
                  user_message: `✅ **${STAGE_DESCRIPTIONS[stage]} 完成**

已保存：${artifactPath}

正在进入下一阶段：${STAGE_DESCRIPTIONS[nextStage]}

**当前进度**：
${stage} ✓ → **${nextStage}** (进行中)

**下一步操作**：
1. 我将使用 ${nextEngines.join(" 和 ")} 生成 ${STAGE_DESCRIPTIONS[nextStage]}
2. 生成后，我会展示给你审查
3. 请确认后，我会调用 submit 提交结果

⚠️ 我不会自动生成或提交，需要你明确指示。`,

                  // 技术信息
                  role_prompt: stageContext.role_prompt,
                  engines: nextEngines,
                  context: this.buildStageContext(session, nextStage),
                  previous_artifact: artifactPath,

                  // 改为 pending_user_actions
                  pending_user_actions: ["review_and_confirm_generation"],
                },
                null,
                2
              ),
            },
          ],
        };
      } else {
        // 工作流完成
        session.current_state = "completed";
        this.saveSession(session);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id: session.session_id,
                  state: "completed",

                  // 工作流完成，无需进一步确认
                  requires_user_confirmation: false,
                  interaction_type: "workflow_completed",

                  // 用户友好的提示信息
                  user_message: `🎉 **BMAD 工作流完成！**

所有阶段已成功完成：
✓ Product Requirements Document (PRD)
✓ System Architecture
✓ Sprint Planning
✓ Development
✓ Code Review
✓ Quality Assurance

**生成的文档**：
${session.artifacts.map((artifact, i) => `${i + 1}. ${artifact}`).join('\n')}

感谢使用 BMAD 工作流！`,

                  // 技术信息
                  artifacts: session.artifacts,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  }

  /**
   * 批准当前阶段
   */
  public approve(input: {
    session_id: string;
    approved: boolean;
    feedback?: string;
  }): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    const session = this.sessions.get(input.session_id);
    if (!session) {
      return this.errorResponse("Session not found");
    }

    const currentStage = session.current_stage;
    const stageData = session.stages[currentStage];

    if (input.approved) {
      // 批准，进入下一阶段
      stageData.approved = true;

      const nextStage = this.getNextStage(currentStage);
      if (nextStage) {
        session.current_stage = nextStage;
        session.current_state = "generating";
        session.stages[nextStage].status = "in_progress";
        this.saveSession(session);

        const stageContext = getStageContext(nextStage);

        // 针对Dev阶段的特殊提示
        let userMessage = "";
        if (nextStage === "dev") {
          // 读取Sprint Plan内容，提取Sprint信息
          const sprintPlanRef = session.stages.sm?.final_result_ref;
          let sprintInfo = "";
          if (sprintPlanRef) {
            try {
              const sprintPlanContent = this.readContentFromFile(session.cwd, sprintPlanRef);
              // 简单提取Sprint标题（## Sprint X:）
              const sprintMatches = sprintPlanContent.match(/## Sprint \d+:.*$/gm);
              if (sprintMatches && sprintMatches.length > 0) {
                sprintInfo = `\n**Sprint Plan 包含 ${sprintMatches.length} 个 Sprint**：\n${sprintMatches.map((s, i) => `${i + 1}. ${s.replace(/^## /, '')}`).join('\n')}\n`;
              }
            } catch (e) {
              // 如果读取失败，忽略
            }
          }

          userMessage = `✅ **${STAGE_DESCRIPTIONS[currentStage]} 已批准**

正在进入下一阶段：**${STAGE_DESCRIPTIONS[nextStage]}**

**当前进度**：
${currentStage} ✓ → **${nextStage}** (进行中)
${sprintInfo}
**⚠️ 重要：请明确指示开发范围**

在开始开发之前，你需要明确告诉我：
1. **开发所有 Sprint**（推荐，确保完整实现）
   - 指令示例："开始开发所有 Sprint" 或 "implement all sprints"
   
2. **仅开发特定 Sprint**（适用于增量开发）
   - 指令示例："开发 Sprint 1" 或 "implement sprint 1 only"

**默认行为**：建议一次性开发所有 Sprint，确保功能完整性和一致性。

**下一步操作**：
1. 等待你明确开发范围指令
2. 使用 ${this.getEnginesForStage(session, nextStage).join(" 和 ")} 根据你的指令生成代码
3. 生成后展示给你审查
4. 确认无误后调用 submit 提交

⚠️ **我不会自动开始开发，必须等待你的明确指令。**`;
        } else {
          userMessage = `✅ **${STAGE_DESCRIPTIONS[currentStage]} 已批准**

正在进入下一阶段：${STAGE_DESCRIPTIONS[nextStage]}

**当前进度**：
${currentStage} ✓ → **${nextStage}** (进行中)

**下一步操作**：
1. 我将使用 ${this.getEnginesForStage(session, nextStage).join(" 和 ")} 生成 ${STAGE_DESCRIPTIONS[nextStage]}
2. 生成后，我会展示给你审查
3. 请确认后，我会调用 submit 提交结果

⚠️ 我不会自动生成或提交，需要你明确指示。`;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id: session.session_id,
                  stage: nextStage,
                  state: "generating",
                  stage_description: STAGE_DESCRIPTIONS[nextStage],

                  // 明确表示需要用户参与
                  requires_user_confirmation: true,
                  interaction_type: "awaiting_generation",

                  // 用户友好的提示信息
                  user_message: userMessage,

                  // 技术信息
                  role_prompt: stageContext.role_prompt,
                  engines: this.getEnginesForStage(session, nextStage),
                  context: this.buildStageContext(session, nextStage),

                  // 改为 pending_user_actions（Dev阶段需要用户明确开发范围）
                  pending_user_actions: nextStage === "dev" 
                    ? ["specify_sprint_scope_then_generate"] 
                    : ["review_and_confirm_generation"],
                },
                null,
                2
              ),
            },
          ],
        };
      } else {
        // 已经是最后阶段
        session.current_state = "completed";
        this.saveSession(session);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id: session.session_id,
                  state: "completed",

                  // 工作流完成，无需进一步确认
                  requires_user_confirmation: false,
                  interaction_type: "workflow_completed",

                  // 用户友好的提示信息
                  user_message: `🎉 **BMAD 工作流完成！**

所有阶段已成功完成：
✓ Product Requirements Document (PRD)
✓ System Architecture
✓ Sprint Planning
✓ Development
✓ Code Review
✓ Quality Assurance

**生成的文档**：
${session.artifacts.map((artifact, i) => `${i + 1}. ${artifact}`).join('\n')}

感谢使用 BMAD 工作流！`,

                  // 技术信息
                  artifacts: session.artifacts,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    } else {
      // 不批准，返回优化
      session.current_state = "refining";
      this.saveSession(session);

      const stageContext = getStageContext(currentStage);
      const dynEngines = this.getEnginesForStage(session, currentStage);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session_id: session.session_id,
                stage: currentStage,
                state: "refining",

                // 明确表示需要用户参与
                requires_user_confirmation: true,
                interaction_type: "awaiting_regeneration",

                // 用户友好的提示信息
                user_message: `❌ **${STAGE_DESCRIPTIONS[currentStage]} 未批准**

你拒绝了当前阶段成果。

${input.feedback ? `**你的反馈**：\n${input.feedback}\n` : ''}

**下一步操作**：
- 我将基于你的反馈重新生成 ${STAGE_DESCRIPTIONS[currentStage]}
- 使用引擎：${dynEngines.join(" 和 ")}
- 生成后会再次展示给你审查

⚠️ 我不会自动重新生成，需要你明确指示。`,

                // 技术信息
                role_prompt: stageContext.role_prompt,
                engines: dynEngines,
                user_feedback: input.feedback,

                // 改为 pending_user_actions
                pending_user_actions: ["regenerate_with_feedback"],
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  /**
   * 用户回答澄清问题
   */
  public answer(input: {
    session_id: string;
    answers: Record<string, string> | string;
  }): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    // 尝试从内存获取 session，不存在则从磁盘回载（提高健壮性）
    let session = this.sessions.get(input.session_id);
    if (!session) {
      try {
        const fallbackDir = process.cwd();
        const sessionPath = path.join(
          fallbackDir,
          ".bmad-task",
          `session-${input.session_id}.json`
        );
        if (fs.existsSync(sessionPath)) {
          const raw = fs.readFileSync(sessionPath, "utf-8");
          const loaded: WorkflowSession = JSON.parse(raw);
          this.sessions.set(input.session_id, loaded);
          session = loaded;
        }
      } catch (e) {
        // 忽略回载异常，走统一错误返回
      }
    }
    if (!session) {
      return this.errorResponse("Session not found");
    }

    const currentStage = session.current_stage;
    const stageData = session.stages[currentStage];

    // 兼容字符串化 answers（部分宿主可能传字符串）
    let normalizedAnswers: Record<string, string> = {};
    try {
      const raw = typeof input.answers === "string" ? JSON.parse(input.answers) : input.answers;
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          normalizedAnswers[k] = (v ?? "").toString().trim();
        }
      }
    } catch {
      // 保底：转为空对象，避免抛错导致流程中断
      normalizedAnswers = {};
    }

    // 保存用户回答
    stageData.answers = normalizedAnswers;

    // 将 answers/questions 写入文件（引用）
    const answersRef = this.saveContentReference(
      session.session_id,
      session.cwd,
      "user_answers",
      currentStage,
      normalizedAnswers,
      "json"
    );
    const questionsRef = this.saveContentReference(
      session.session_id,
      session.cwd,
      "questions",
      currentStage,
      stageData.questions || [],
      "json"
    );

    // 状态变为 refining
    session.current_state = "refining";
    this.saveSession(session);

    const stageContext = getStageContext(currentStage);
    const dynEngines = this.getEnginesForStage(session, currentStage);

    // 用户消息（引用）
    const fullUserMessage = `📝 **已收到你的回答**

基于你的回答，我准备重新生成 ${STAGE_DESCRIPTIONS[currentStage]}。

**你的回答**（详见文件：${answersRef.file_path}）：
${Object.entries(stageData.answers || {}).slice(0, 3).map(([id, answer]) => `- [${id}]: ${String(answer).substring(0, 100)}...`).join('\n')}

**下一步操作**：
- 我将基于你的回答重新生成文档
- 使用引擎：${dynEngines.join(" 和 ")}

⚠️ 我不会自动重新生成，需要你明确指示。`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              session_id: session.session_id,
              stage: currentStage,
              state: "refining",

              // 明确表示需要用户参与
              requires_user_confirmation: true,
              interaction_type: "awaiting_regeneration",

              user_message: fullUserMessage,

              // 文件引用
              user_answers_ref: answersRef,

              // 技术信息（不包含大文本）
              role_prompt: stageContext.role_prompt,
              engines: dynEngines,
              context: {
                objective: session.objective,
                previous_draft_ref: stageData.final_result_ref,
                questions_ref: questionsRef,
                user_answers_ref: answersRef,
                previous_score: stageData.score,
              },

              // 改为 pending_user_actions
              pending_user_actions: ["regenerate_with_answers"],
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * 用户确认保存文档
   */
  public confirmSave(input: {
    session_id: string;
    confirmed: boolean;
  }): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    const session = this.sessions.get(input.session_id);
    if (!session) {
      return this.errorResponse("Session not found");
    }

    const currentStage = session.current_stage;
    const stageData = session.stages[currentStage];

    if (!input.confirmed) {
      // 用户拒绝保存，回到 clarifying 状态
      session.current_state = "clarifying";
      this.saveSession(session);

      {
        const questions = stageData.questions || [];
        const gaps = stageData.gaps || [];
        const draft = stageData.draft || "";

        // 保存引用
        const questionsRef = this.saveContentReference(
          session.session_id,
          session.cwd,
          "questions",
          currentStage,
          questions,
          "json"
        );
        const gapsRef = this.saveContentReference(
          session.session_id,
          session.cwd,
          "gaps",
          currentStage,
          gaps,
          "json"
        );
        const draftRef = this.saveContentReference(
          session.session_id,
          session.cwd,
          "draft",
          currentStage,
          draft,
          "md"
        );

        const fullUserMessage = `⚠️ **【需要用户输入，禁止自动回答】**

❌ 保存已取消
你已取消保存 ${STAGE_DESCRIPTIONS[currentStage]} 文档。

**可用操作**：
1. 回答澄清问题以改进文档
2. 提供更多信息
3. 重新審查当前草稿

**文件位置**：
- 问题列表：${questionsRef.file_path}
- 空白点：${gapsRef.file_path}
- 草稿内容：${draftRef.file_path}

---
回答方式：
\`\`\`
bmad-task action=answer session_id=${session.session_id} answers={"q1":"...","q2":"..."}
\`\`\`

⚠️ **【重要】请用户亲自回答上述问题，AI 不应自动编造答案。**`;

        const userMessageRef = fullUserMessage.length > 1000
          ? this.saveContentReference(
              session.session_id,
              session.cwd,
              "user_message",
              currentStage,
              fullUserMessage,
              "md"
            )
          : null;

        const payload = {
          session_id: session.session_id,
          stage: currentStage,
          state: "clarifying",

          // 明确表示需要用户参与
          requires_user_confirmation: true,
          interaction_type: "user_decision",
          // 显式禁止自动执行（强制等待）
          STOP_AUTO_EXECUTION: true,
          must_wait_for_user: true,

          // 用户消息：内联或引用
          user_message: userMessageRef
            ? `📄 完整说明见文件：${userMessageRef.file_path}\n\n摘要：${userMessageRef.summary}`
            : fullUserMessage,

          // 文件引用
          questions_ref: questionsRef,
          gaps_ref: gapsRef,
          draft_ref: draftRef,
          user_message_ref: userMessageRef,

          // 简短内联信息（兼容旧客户端）
          questions_count: questions.length,
          gaps_count: gaps.length,
          questions_summary: `${questions.length} questions: ${questions.slice(0, 2).map((q: any) => q.id).join(", ")}${questions.length > 2 ? "..." : ""}`,
          gaps_summary: `${gaps.length} gaps identified`,

          // 改为 pending_user_actions
          pending_user_actions: ["answer_questions", "review_draft"],
        };
        const text = JSON.stringify(payload, null, 2);
        console.error(`[DEBUG] Response size: ${this.estimateTokensFromString(text)} tokens (with file references)`);
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      }
    }

    // 用户确认保存
    if (!stageData.final_result_ref) {
      return this.errorResponse("No final result to save");
    }

    // 从引用读取完整内容
    const finalResult = this.readContentFromFile(session.cwd, stageData.final_result_ref);

    const artifactPath = this.saveArtifact(
      session.session_id,
      session.cwd,
      currentStage,
      finalResult
    );

    session.artifacts.push(artifactPath);
    stageData.status = "completed";

    // 一次确认后：直接进入下一阶段
    const nextStage = this.getNextStage(currentStage);
    if (nextStage) {
      session.current_stage = nextStage;
      session.current_state = "generating";
      session.stages[nextStage].status = "in_progress";
      this.saveSession(session);

      const stageContext = getStageContext(nextStage);
      const nextEngines = this.getEnginesForStage(session, nextStage);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session_id: session.session_id,
                stage: nextStage,
                state: "generating",
                stage_description: STAGE_DESCRIPTIONS[nextStage],

                // 明确表示需要用户参与
                requires_user_confirmation: true,
                interaction_type: "awaiting_generation",

                // 用户友好的提示信息
                user_message: `💾 **文档已保存，并已进入下一阶段**

已保存：${artifactPath}
下一阶段：${STAGE_DESCRIPTIONS[nextStage]}

你只需一次确认（confirm/confirm_save），已自动保存并进入下一阶段。

**下一步操作**：
1. 我将使用 ${nextEngines.join(" 和 ")} 生成 ${STAGE_DESCRIPTIONS[nextStage]}
2. 生成后，我会展示给你审查
3. 需要时请继续提交/确认

⚠️ 我不会自动生成或提交，需要你明确指示。`,

                // 技术信息
                role_prompt: stageContext.role_prompt,
                engines: nextEngines,
                context: this.buildStageContext(session, nextStage),
                previous_artifact: artifactPath,

                // 改为 pending_user_actions
                pending_user_actions: ["review_and_confirm_generation"],
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      // 工作流完成（理论上不会发生在 PO/Architect，但保底处理）
      session.current_state = "completed";
      this.saveSession(session);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session_id: session.session_id,
                state: "completed",

                requires_user_confirmation: false,
                interaction_type: "workflow_completed",

                user_message: `🎉 **BMAD 工作流完成！**\n\n生成的文档：\n${session.artifacts.map((artifact, i) => `${i + 1}. ${artifact}`).join('\n')}`,
                artifacts: session.artifacts,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  /**
   * 新增别名：confirm（兼容旧的 confirm_save）
   */
  public confirm(input: {
    session_id: string;
    confirmed: boolean;
  }): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    return this.confirmSave(input);
  }

  /**
   * 查询状态
   */
  public status(input: {
    session_id: string;
  }): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    const session = this.sessions.get(input.session_id);
    if (!session) {
      return this.errorResponse("Session not found");
    }

    // 返回轻量级session（节省token）
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            this.getLightweightSession(session),
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * 错误响应
   */
  private errorResponse(message: string): {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  } {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: message,
              status: "failed",
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  /**
   * 简单评分（模拟）
   */
  private scoreContent(content: string): number {
    // 1. 优先匹配 JSON 格式 "quality_score": 92 (支持冒号前后空格)
    const jsonScorePattern = /"quality_score"\s*:\s*(\d+)/g;
    const jsonMatches = content.match(jsonScorePattern);

    if (jsonMatches && jsonMatches.length > 0) {
      // 取最后一个匹配（避免误匹配 PRD 正文中的示例）
      const lastMatch = jsonMatches[jsonMatches.length - 1];
      const scoreStr = lastMatch.match(/\d+/);
      if (scoreStr) {
        const score = parseInt(scoreStr[0], 10);
        // 校验范围 0-100
        if (score >= 0 && score <= 100) {
          return score;
        }
      }
    }

    // 2. 匹配文本格式 Quality Score: X/100
    const textScoreMatch = content.match(/Quality Score:\s*(\d+)\/100/i);
    if (textScoreMatch) {
      const score = parseInt(textScoreMatch[1], 10);
      if (score >= 0 && score <= 100) {
        return score;
      }
    }

    // 3. 回退：基于内容章节完整性评分（而非简单长度）
    return this.estimateScoreByContent(content);
  }

  /**
   * 基于内容质量估算评分（回退方法）
   */
  private estimateScoreByContent(content: string): number {
    let score = 60; // 基础分

    // 检查关键章节（每个 +5 分）
    const sections = [
      "Executive Summary",
      "Business Goals",
      "User Stories",
      "Functional Requirements",
      "Technical Requirements",
      "Success Metrics"
    ];

    for (const section of sections) {
      if (content.includes(section)) score += 5;
    }

    // 检查量化指标（+5 分）
    if (/\d+%|<\s*\d+ms|>\s*\d+/.test(content)) score += 5;

    // 检查验收标准（+5 分）
    if (content.includes("Acceptance Criteria") || content.includes("验收标准")) {
      score += 5;
    }

    return Math.min(score, 85); // 回退方法最高 85 分
  }

  /**
   * 分析 PRD 质量不足之处（用于改进指导）
   */
  private analyzePRDQuality(content: string, currentScore: number): string[] {
    const gaps: string[] = [];
    const expectedScore = 90;
    const deficit = expectedScore - currentScore;
    const lowerContent = content.toLowerCase();

    // 检查必要章节（每个 5 分）
    const requiredSections = [
      { name: "Executive Summary", points: 5 },
      { name: "Business Goals", points: 5 },
      { name: "User Stories", points: 10 },
      { name: "Functional Requirements", points: 10 },
      { name: "Technical Requirements", points: 8 },
      { name: "Success Metrics", points: 7 },
      { name: "Scope & Priorities", points: 5 }
    ];

    for (const section of requiredSections) {
      if (!lowerContent.includes(section.name.toLowerCase())) {
        gaps.push(`缺少 "${section.name}" 章节 (-${section.points}分)`);
      }
    }

    // 检查量化指标（10 分）
    if (!/\d+%|<\s*\d+ms|>\s*\d+|≥\s*\d+/.test(lowerContent)) {
      gaps.push("缺少量化的成功指标（需要具体数字：延迟 <100ms、成功率 >95%、覆盖率 ≥80% 等） (-10分)");
    }

    // 检查 User Stories 结构（10 分）
    if (!lowerContent.includes("acceptance criteria") && !lowerContent.includes("验收标准") && !lowerContent.includes("ac")) {
      gaps.push("User Stories 缺少验收标准（每个 Story 需要 3-5 个可测试的 Acceptance Criteria） (-10分)");
    }

    // 检查技术决策说明（5 分）
    if (!lowerContent.includes("依赖") && !lowerContent.includes("dependencies") && !lowerContent.includes("dependency")) {
      gaps.push("技术要求章节缺少依赖说明和版本约束（如 Rust ≥1.70, tokio 1.x） (-5分)");
    }

    // 检查错误处理场景（8 分）
    if (!lowerContent.includes("error") && !lowerContent.includes("错误") && !lowerContent.includes("edge case")) {
      gaps.push("缺少错误处理和边界情况说明（每个功能至少 3-5 个错误场景） (-8分)");
    }

    // 检查时间线规划（5 分）
    if (!lowerContent.includes("timeline") && !lowerContent.includes("milestone") && !lowerContent.includes("时间线") && !lowerContent.includes("里程碑")) {
      gaps.push("缺少时间线和里程碑规划 (-5分)");
    }

    // 如果没有找到具体问题，给出通用建议
    if (gaps.length === 0) {
      gaps.push(`当前评分 ${currentScore}/100，距离目标 ${expectedScore} 分还差 ${deficit} 分`);
      gaps.push("建议：增加技术细节、量化指标、用户故事的验收标准、错误处理场景");
    }

    return gaps;
  }

  /**
   * 从结果中提取澄清问题
   */
  private extractQuestions(content: string): ClarificationQuestion[] {
    const questions: ClarificationQuestion[] = [];

    try {
      // 尝试解析 JSON 格式的问题
      const jsonMatch = content.match(/"questions":\s*\[([\s\S]*?)\]/);
      if (jsonMatch) {
        const questionsArray = JSON.parse(`[${jsonMatch[1]}]`);
        return questionsArray.map((q: any, idx: number) => ({
          id: q.id || `q${idx + 1}`,
          question: q.question || String(q),
          context: q.context,
        }));
      }
    } catch (e) {
      // 如果 JSON 解析失败，尝试正则提取
    }

    return questions;
  }

  /**
   * 从结果中提取空白点
   */
  private extractGaps(content: string): string[] {
    const gaps: string[] = [];

    try {
      const jsonMatch = content.match(/"gaps":\s*\[([\s\S]*?)\]/);
      if (jsonMatch) {
        const gapsArray = JSON.parse(`[${jsonMatch[1]}]`);
        return gapsArray.map((g: any) => String(g));
      }
    } catch (e) {
      // Ignore parse errors
    }

    return gaps;
  }

  /**
   * 从结果中提取草稿内容（统一版，支持所有阶段字段）
   */
  private extractDraftLegacy(content: string): string {
    // 1) 优先尝试解析为 JSON 对象
    try {
      const json = JSON.parse(content);
      if (json && typeof json === 'object') {
        if (typeof json.prd_draft === 'string') return json.prd_draft;
        if (typeof json.prd_updated === 'string') return json.prd_updated;
        if (typeof json.architecture_draft === 'string') return json.architecture_draft;
        if (typeof json.architecture_updated === 'string') return json.architecture_updated;
        if (typeof json.draft === 'string') return json.draft;
      }
    } catch {}

    // 2) 提取 JSON 片段（如存在于文本或代码块中）
    try {
      const codeBlockJson = content.match(/```json\s*([\s\S]*?)\s*```/i);
      if (codeBlockJson) {
        const json = JSON.parse(codeBlockJson[1]);
        if (json && typeof json === 'object') {
          if (typeof json.prd_draft === 'string') return json.prd_draft;
          if (typeof json.prd_updated === 'string') return json.prd_updated;
          if (typeof json.architecture_draft === 'string') return json.architecture_draft;
          if (typeof json.architecture_updated === 'string') return json.architecture_updated;
          if (typeof json.draft === 'string') return json.draft;
        }
      }
    } catch {}

    // 3) 正则提取转义字符串字段（宽松匹配）
    const match = content.match(/"(?:prd_draft|prd_updated|architecture_draft|architecture_updated|draft)":\s*"([\s\S]*?)"/);
    if (match) {
      return match[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\"/g, '"');
    }

    // 4) 回退：返回原始内容（可能已是 Markdown）
    return content;
  }

  /**
   * 从结果中提取草稿内容（支持所有阶段字段，优先阶段特定字段，回退通用字段）
   */
  private extractDraft(content: string): string {
    // 构建所有可能字段列表（阶段特定在前，通用在后）
    const allFields: string[] = [
      ...this.STAGE_CONTENT_FIELDS.po,
      ...this.STAGE_CONTENT_FIELDS.architect,
      ...this.STAGE_CONTENT_FIELDS.sm,
      ...this.STAGE_CONTENT_FIELDS.dev,
      ...this.STAGE_CONTENT_FIELDS.review,
      ...this.STAGE_CONTENT_FIELDS.qa,
      ...this.STAGE_CONTENT_FIELDS.common,
    ];

    // 1) 优先尝试整体解析为 JSON
    try {
      const json = JSON.parse(content);
      if (json && typeof json === 'object') {
        for (const field of allFields) {
          if (typeof (json as any)[field] === 'string') {
            return (json as any)[field];
          }
        }
      }
    } catch {}

    // 2) 提取代码块中的 JSON（```json ... ```）
    try {
      const codeBlockJson = content.match(/```json\s*([\s\S]*?)\s*```/i);
      if (codeBlockJson) {
        const json = JSON.parse(codeBlockJson[1]);
        if (json && typeof json === 'object') {
          for (const field of allFields) {
            if (typeof (json as any)[field] === 'string') {
              return (json as any)[field];
            }
          }
        }
      }
    } catch {}

    // 3) 正则提取转义字符串字段（宽松匹配，支持所有字段）
    const fieldPattern = allFields.join('|');
    const match = content.match(new RegExp(`\"(?:${fieldPattern})\":\\s*\"([\\s\\S]*?)\"`, 'm'));
    if (match) {
      return match[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\"/g, '"');
    }

    // 4) 回退：原文（可能已是 Markdown）
    return content;
  }

  /**
   * 合并两组问题（去重）
   */
  private mergeQuestions(
    questions1: ClarificationQuestion[],
    questions2: ClarificationQuestion[]
  ): ClarificationQuestion[] {
    const merged = [...questions1];
    const existingQuestions = new Set(questions1.map(q => q.question.toLowerCase()));

    for (const q of questions2) {
      if (!existingQuestions.has(q.question.toLowerCase())) {
        merged.push(q);
        existingQuestions.add(q.question.toLowerCase());
      }
    }

    return merged;
  }

  /**
   * 保存 artifact
   */
  private saveArtifact(
    sessionId: string,
    cwd: string,
    stage: WorkflowStage,
    content: string
  ): string {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // 防御性处理：始终在写入前提取纯 Markdown（幂等）
    const cleanedContent = this.extractDraft(content);

    // 使用task_name而不是sessionId作为目录名
    const artifactsDir = path.join(cwd, ".claude", "specs", session.task_name);

    // 确保目录存在
    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
    }

    const filename = WORKFLOW_DEFINITION.artifacts[stage];
    const filePath = path.join(artifactsDir, filename);

    // 简单的 Markdown 检测（避免 JSON 误写入）
    const trimmed = (cleanedContent || "").trim();
    const isLikelyJson = trimmed.startsWith("{") || /"quality_score"\s*:\s*\d+/.test(trimmed);
    const isMarkdown = !isLikelyJson;
    console.error(`[DEBUG] saveArtifact: stage=${stage}, isMarkdown=${isMarkdown}, size=${cleanedContent.length}`);

    fs.writeFileSync(filePath, cleanedContent, "utf-8");

    // 返回相对路径
    return path.relative(cwd, filePath);
  }

  /**
   * 保存 session
   */
  private saveSession(session: WorkflowSession): void {
    const sessionDir = path.join(session.cwd, ".bmad-task");

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const sessionPath = path.join(
      sessionDir,
      `session-${session.session_id}.json`
    );

    session.updated_at = new Date().toISOString();

    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), "utf-8");
  }

  /**
   * 获取下一阶段
   */
  private getNextStage(currentStage: WorkflowStage): WorkflowStage | null {
    const stages = WORKFLOW_DEFINITION.stages;
    const currentIndex = stages.indexOf(currentStage);

    if (currentIndex >= 0 && currentIndex < stages.length - 1) {
      return stages[currentIndex + 1];
    }

    return null;
  }

  /**
   * 构建阶段上下文
   */
  private buildStageContext(
    session: WorkflowSession,
    stage: WorkflowStage
  ): Record<string, any> {
    const context: Record<string, any> = {
      objective: session.objective,
    };

    // 包含之前阶段的结果
    if (stage !== "po") {
      const previousStages = WORKFLOW_DEFINITION.stages.slice(
        0,
        WORKFLOW_DEFINITION.stages.indexOf(stage)
      );

      for (const prevStage of previousStages) {
        const stageData = session.stages[prevStage];
        if (stageData.final_result_ref) {
          // 从引用读取完整内容
          context[prevStage] = this.readContentFromFile(
            session.cwd,
            stageData.final_result_ref
          );
        }
      }
    }

    return context;
  }
}

/**
 * MCP 工具定义
 */
const BMAD_TOOL: Tool = {
  name: "bmad-task",
  description: `BMAD (Business-Minded Agile Development) workflow orchestrator.

Manages complete development workflow: PO → Architect → SM → Dev → Review → QA.

Key features:
- Master orchestrator with embedded role prompts
- Interactive clarification process (PO/Architect stages)
- Dynamic engine selection (Claude/Codex)
- Quality gates and approval points
- Artifact management
- Project-level state tracking

This tool returns:
1. Current stage and role prompt
2. Required engines (claude/codex/both)
3. Context and inputs for the role
4. Next action required

It does NOT call LLMs directly - that's Claude Code's responsibility.`,

  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "submit", "answer", "confirm", "confirm_save", "approve", "status"],
        description: "Action type",
      },
      session_id: {
        type: "string",
        description: "Session ID (required except for 'start')",
      },
      cwd: {
        type: "string",
        description: "Project directory (required for 'start')",
      },
      objective: {
        type: "string",
        description: "Project objective (required for 'start')",
      },
      stage: {
        type: "string",
        enum: ["po", "architect", "sm", "dev", "review", "qa"],
        description: "Stage for submission (required for 'submit')",
      },
      claude_result: {
        type: "string",
        description: "Result from Claude (for 'submit')",
      },
      codex_result: {
        type: "string",
        description: "Result from Codex (for 'submit')",
      },
      answers: {
        type: "object",
        description: "User answers to clarification questions (for 'answer')",
        // 允许任意键，值为字符串
        additionalProperties: { type: "string" } as any,
      },
      confirmed: {
        type: "boolean",
        description: "Confirmation status (for 'confirm'/'confirm_save')",
      },
      approved: {
        type: "boolean",
        description: "Approval status (for 'approve')",
      },
      feedback: {
        type: "string",
        description: "User feedback (for 'approve')",
      },
    },
    required: ["action"],
  },
};

/**
 * 主服务器
 */
const server = new Server(
  {
    name: "bmad-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const workflowServer = new BmadWorkflowServer();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [BMAD_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "bmad-task") {
    const args = request.params.arguments as Record<string, any>;

    switch (args.action) {
      case "start":
        return workflowServer.start({
          cwd: args.cwd,
          objective: args.objective,
        });

      case "submit":
        return workflowServer.submit({
          session_id: args.session_id,
          stage: args.stage,
          claude_result: args.claude_result,
          codex_result: args.codex_result,
        });

      case "answer":
        return workflowServer.answer({
          session_id: args.session_id,
          answers: args.answers || {},
        });

      case "confirm":
        return workflowServer.confirm({
          session_id: args.session_id,
          confirmed: args.confirmed,
        });

      case "confirm_save":
        return workflowServer.confirmSave({
          session_id: args.session_id,
          confirmed: args.confirmed,
        });

      case "approve":
        return workflowServer.approve({
          session_id: args.session_id,
          approved: args.approved,
          feedback: args.feedback,
        });

      case "status":
        return workflowServer.status({
          session_id: args.session_id,
        });

      default:
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Unknown action: ${args.action}`,
              }),
            },
          ],
          isError: true,
        };
    }
  }

  return {
    content: [
      {
        type: "text",
        text: `Unknown tool: ${request.params.name}`,
      },
    ],
    isError: true,
  };
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BMAD MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
