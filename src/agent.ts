import { ipcMain, BrowserWindow, dialog } from 'electron';

// ─────────────────────────────────────────────
//  类型定义
// ─────────────────────────────────────────────

interface PageData {
  snapshot?: string;
  tradeInfo?: unknown;
  [key: string]: unknown;
}

interface AgentConfig {
  mcpServerUrl: string;
  model?: string;
  maxTokens?: number;
  apiKey?: string;
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface KimiResponse {
  choices: {
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }[];
}

// AI 返回的单条填写计划
interface FillPlanItem {
  selector: string;   // CSS 选择器
  label: string;      // 字段名称，如"姓名"
  value: string;      // 要填入的值
}

// ─────────────────────────────────────────────
//  Agent 核心类
// ─────────────────────────────────────────────

export class FormFillerAgent {
  private config: AgentConfig;
  private mcpClient: any = null;

  // ── Phase 1：分析阶段 system prompt ──────────
  private readonly SKILL_ANALYZE = `
你是一个自动表单填写助手。你的任务分两个阶段执行。

## 当前阶段：Phase 1 - 分析匹配（只分析，不填写）

### 步骤
1. 调用 get_trade_info() 获取用户数据
2. 调用 get_page_snapshot() 获取页面所有可交互的表单元素
3. 将数据与表单字段智能匹配
4. 以 JSON 格式返回填写计划，不要调用 fill_input()

### 返回格式（严格遵守，只返回 JSON，不要有其他文字）
[
  { "selector": "#name", "label": "姓名", "value": "张三" },
  { "selector": "input[name='age']", "label": "年龄", "value": "28" }
]

### 字段匹配规则
- 根据输入框的 placeholder、id、name、class 属性语义匹配
- 空值、null、0 跳过不包含在结果中
- 只匹配页面上真实存在的输入框，不假设字段
- 只使用 get_trade_info 返回的真实数据，不捏造
`.trim();

  // ── Phase 2：执行阶段 system prompt ──────────
  private readonly SKILL_EXECUTE = `
你是一个自动表单填写助手。你的任务是执行表单填写。

## 当前阶段：Phase 2 - 执行填写

用户已确认以下填写计划，请逐项调用 fill_input() 完成填写，完成后返回"填写完成"。

### 注意事项
- 按计划逐字段调用 fill_input()
- el-select 下拉框需先点击展开再选择
- 全部填写完毕后返回简短的完成汇总
`.trim();

  constructor(config: AgentConfig) {
    this.config = {
      model: 'moonshot-v1-8k',
      maxTokens: 4096,
      ...config,
    };
  }

  // ─────────────────────────────────────────────
  //  注册 IPC 监听
  // ─────────────────────────────────────────────

  register() {
    ipcMain.on('page-info', async (event, payload: PageData | string) => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'AI Agent 提示',
        message: '检测到打开了新的交易，是否需要AI助手自动填写表单？',
        buttons: ['是', '否'],
      });

      if (response !== 0) return;

      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;

      try {
        const pageData: PageData =
          typeof payload === 'string' ? JSON.parse(payload) : payload;

        console.log('[Agent] 收到 page-info 消息，开始处理...');
        event.sender.send('agent-status', { status: 'start' });

        const result = await this.runFormFiller(pageData, win);

        event.sender.send('agent-result', { status: 'done', result });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Agent] 处理失败:', message);
        event.sender.send('agent-result', { status: 'error', message });
      }
    });

    console.log('[Agent] IPC 监听已注册，等待 page-info 消息...');
  }

  // ─────────────────────────────────────────────
  //  初始化 MCP 客户端
  // ─────────────────────────────────────────────

  private async initMcp(): Promise<void> {
    if (this.mcpClient) return;

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const client = new Client(
      { name: 'form-filler-agent', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StdioClientTransport({
      command: 'node',
      args: ['C:\\Users\\12415\\Downloads\\code\\my-electron-mcp\\my-electron-mcp\\dist\\server.js'],
      env: process.env,
    });

    await client.connect(transport);
    this.mcpClient = client;
    console.log('[Agent] MCP (stdio) 连接成功');
  }

  // ─────────────────────────────────────────────
  //  从 MCP 获取 tools，转换为 Kimi function calling 格式
  // ─────────────────────────────────────────────

  private async getMcpToolsForKimi(): Promise<object[]> {
    await this.initMcp();
    const { tools } = await this.mcpClient.listTools();
    console.log('[Agent] 从 MCP 获取到工具:', tools.map((t: any) => t.name));
    return tools.map((tool: any) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    }));
  }

  // ─────────────────────────────────────────────
  //  通过 MCP 执行工具
  // ─────────────────────────────────────────────

  private async callMcpTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    await this.initMcp();
    const result = await this.mcpClient.callTool({ name: toolName, arguments: args });
    const text = (result.content ?? [])
      .map((c: any) => c.text ?? '')
      .filter(Boolean)
      .join('\n');
    return text || JSON.stringify(result);
  }

  // ─────────────────────────────────────────────
  //  通用 AI 调用循环（支持工具调用）
  // ─────────────────────────────────────────────

  private async runAiLoop(
    systemPrompt: string,
    userPrompt: string,
    tools: object[],
  ): Promise<string> {
    const apiKey = this.config.apiKey ?? process.env.MOONSHOT_API_KEY ?? '';

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    while (true) {
      const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          messages,
          tools,
          tool_choice: 'auto',
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Kimi API 请求失败: ${response.status} ${errText}`);
      }

      const data: KimiResponse = await response.json();
      const choice = data.choices[0];
      const assistantMsg = choice.message;

      messages.push({
        role: 'assistant',
        content: assistantMsg.content ?? null,
        tool_calls: assistantMsg.tool_calls,
      });

      if (choice.finish_reason === 'stop' || !assistantMsg.tool_calls?.length) {
        return assistantMsg.content ?? '';
      }

      for (const toolCall of assistantMsg.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch { }

        console.log(`[Agent] 调用 MCP 工具: ${toolCall.function.name}`, args);
        const toolResult = await this.callMcpTool(toolCall.function.name, args);
        console.log(`[Agent] MCP 工具结果 [${toolCall.function.name}]:`, toolResult);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: toolResult,
        });
      }
    }
  }

  // ─────────────────────────────────────────────
  //  核心流程：分析 → 确认 → 执行
  // ─────────────────────────────────────────────

  private async runFormFiller(pageData: PageData, win: BrowserWindow): Promise<string> {
    const tools = await this.getMcpToolsForKimi();

    // ── Phase 1：让 AI 分析，返回填写计划 ────────
    console.log('[Agent] Phase 1：AI 分析填写计划...');
    const planJson = await this.runAiLoop(
      this.SKILL_ANALYZE,
      '请分析当前页面，返回填写计划（JSON格式）。',
      tools,
    );

    console.log('[Agent] AI 返回填写计划:', planJson);

    // ── 解析填写计划 ──────────────────────────────
    let plan: FillPlanItem[] = [];
    try {
      // 去掉可能的 markdown 代码块包裹
      const cleaned = planJson.replace(/```json|```/g, '').trim();
      plan = JSON.parse(cleaned);
    } catch {
      throw new Error(`AI 返回的填写计划格式错误:\n${planJson}`);
    }

    if (!plan.length) {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: 'AI Agent',
        message: '未找到可填写的表单字段，请确认页面是否已加载完成。',
        buttons: ['确定'],
      });
      return '无可填写字段';
    }

    // ── 弹窗展示填写计划，等用户确认 ──────────────
    const planText = plan
      .map((item, i) => `${i + 1}. ${item.label}：${item.value}`)
      .join('\n');

    const { response: confirmResponse } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'AI Agent - 确认填写',
      message: 'AI 将填写以下字段，确认后开始执行：',
      detail: planText,
      buttons: ['确认填写', '取消'],
      defaultId: 0,
      cancelId: 1,
    });

    if (confirmResponse !== 0) {
      console.log('[Agent] 用户取消填写');
      return '用户已取消';
    }

    // ── Phase 2：用户确认，执行填写 ───────────────
    console.log('[Agent] Phase 2：执行填写...');
    const executePrompt = `请按照以下计划逐项填写表单：\n${JSON.stringify(plan, null, 2)}`;
    const result = await this.runAiLoop(
      this.SKILL_EXECUTE,
      executePrompt,
      tools,
    );

    console.log('[Agent] 填写完成:', result);
    return result;
  }

  // ─────────────────────────────────────────────
  //  断开 MCP 连接
  // ─────────────────────────────────────────────

  async disconnect(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.close();
      this.mcpClient = null;
      console.log('[Agent] MCP 连接已断开');
    }
  }
}

// ─────────────────────────────────────────────
//  工厂函数
// ─────────────────────────────────────────────

export function createFormFillerAgent(config: AgentConfig): FormFillerAgent {
  const agent = new FormFillerAgent(config);
  agent.register();
  return agent;
}