import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import puppeteer from "puppeteer-core";
import { z } from "zod";
/**
 * Electron MCP Server
 * 用于通过 Chrome DevTools Protocol (CDP) 控制本地 Electron 应用
 *
 * 使用方法:
 * 1. 启动 Electron 应用时添加参数: electron . --remote-debugging-port=9222
 * 2. 启动此 MCP 服务: node dist/server.js
 * 3. 通过 Claude Desktop 或其他 MCP 客户端调用提供的工具
 */
// ═══════════════════════════════════════════════════════════════
//  全局状态管理
// ═══════════════════════════════════════════════════════════════
let browser = null;
let pages = new Map();
let mainPage = null;
/**
 * 连接到本地 Electron 应用
 * @param port - Chrome DevTools Protocol 端口，默认 9222
 */
async function connectToElectron(port = 9222) {
    // 如果已连接，返回主页面
    if (mainPage && browser) {
        try {
            // 验证连接是否仍然有效
            await mainPage.evaluate(() => true);
            return mainPage;
        }
        catch {
            // 连接丢失，重置状态
            mainPage = null;
            pages.clear();
        }
    }
    try {
        // 连接到 Electron 的 CDP 端口
        browser = await puppeteer.connect({
            browserURL: `http://localhost:${port}`,
            defaultViewport: null,
        });
        const pageList = await browser.pages();
        if (pageList.length === 0) {
            throw new Error(`Electron 中没有可用的页面。请确保 Electron 已启动并使用了 --remote-debugging-port=${port}`);
        }
        // 缓存所有页面
        mainPage = pageList[0];
        pageList.forEach((p, index) => {
            pages.set(`page_${index}`, p);
        });
        // 监听连接断开事件
        browser.on("disconnected", () => {
            console.error("❌ Electron 连接已断开");
            browser = null;
            mainPage = null;
            pages.clear();
        });
        console.error(`✅ 已连接到 Electron（共 ${pageList.length} 个页面）`);
        return mainPage;
    }
    catch (error) {
        throw new Error(`无法连接到 Electron: ${error instanceof Error ? error.message : String(error)}\n` +
            `请确保:\n` +
            `1. Electron 应用已启动\n` +
            `2. 使用了 --remote-debugging-port=9222 参数\n` +
            `3. 防火墙未阻止本地连接`);
    }
}
/**
 * 获取指定的页面
 */
async function getPage(pageId = "main") {
    const page = pageId === "main" ? mainPage : pages.get(pageId);
    if (!page) {
        throw new Error(`页面 "${pageId}" 不存在`);
    }
    return page;
}
// ═══════════════════════════════════════════════════════════════
//  创建 MCP Server
// ═══════════════════════════════════════════════════════════════
const server = new McpServer({
    name: "electron-controller",
    version: "1.0.0",
});
// ═══════════════════════════════════════════════════════════════
//  工具1: 获取页面快照
// ═══════════════════════════════════════════════════════════════
/**
 * 获取当前 Electron 页面的快照，包括页面标题、URL 和所有交互元素信息
 */
server.registerTool("get_page_snapshot", {
    title: "获取页面快照",
    description: "获取当前 Electron 页面的 HTML 结构和文本内容，用于了解页面上有哪些可交互的元素",
    inputSchema: z.object({}),
}, async () => {
    try {
        const page = await connectToElectron();
        const snapshot = await page.evaluate(() => {
            // 提取所有可交互元素的信息
            const elements = [];
            // 扫描常见的交互元素
            const interactiveSelectors = "button, input, select, textarea, a, [role='button'], [role='link'], [onclick]";
            document.querySelectorAll(interactiveSelectors).forEach((el, index) => {
                const htmlEl = el;
                const inputEl = el;
                // 生成唯一的选择器
                let selector = "";
                if (htmlEl.id) {
                    selector = `#${htmlEl.id}`;
                }
                else if (htmlEl.className) {
                    selector = `.${htmlEl.className.split(" ").join(".")}`;
                }
                else {
                    selector = `${htmlEl.tagName.toLowerCase()}:nth-of-type(${index})`;
                }
                elements.push({
                    tag: htmlEl.tagName.toLowerCase(),
                    id: htmlEl.id || undefined,
                    class: htmlEl.className || undefined,
                    type: inputEl.type || undefined,
                    placeholder: inputEl.placeholder || undefined,
                    name: inputEl.name || undefined,
                    text: htmlEl.innerText?.trim().slice(0, 100) || inputEl.value || undefined,
                    selector,
                });
            });
            return {
                title: document.title,
                url: location.href,
                elementCount: elements.length,
                elements: elements.slice(0, 50), // 限制返回数量
            };
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(snapshot, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `❌ 获取页面快照失败: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
});
// ═══════════════════════════════════════════════════════════════
//  工具X2: 读取 window.x5.globalApp.config.globalProperties.$pinia._s
// ═══════════════════════════════════════════════════════════════
/**
 * 读取 window.x5.globalApp.config.globalProperties.$pinia._s 的值并返回序列化结果
 */
async function getX5PiniaS(page) {
    return await page.evaluate(() => {
        try {
            const val = window.x5?.globalApp?.config?.globalProperties?.$pinia?._s;
            if (val === undefined)
                return { found: false, message: 'window.x5...$pinia._s 未定义' };
            if (val instanceof Map) {
                const internalKeys = ['$id', '$onAction', '$patch', '$reset', '$subscribe', '$dispose', '_hotUpdate', '_isOptionsAPI'];
                /**
                 * Vue3 响应式 Proxy 对象上存有 __v_raw 属性指向原始对象。
                 * 递归解包，确保嵌套的响应式值也能被正确序列化。
                 */
                function deepRaw(v) {
                    if (v === null || v === undefined)
                        return v;
                    const raw = v['__v_raw'] !== undefined ? v['__v_raw'] : v;
                    if (Array.isArray(raw))
                        return raw.map(deepRaw);
                    if (raw && typeof raw === 'object') {
                        const result = {};
                        Object.keys(raw).forEach(k => { result[k] = deepRaw(raw[k]); });
                        return result;
                    }
                    return raw;
                }
                const obj = {};
                val.forEach((storeValue, key) => {
                    const rawStore = storeValue['__v_raw'] ?? storeValue;
                    const data = {};
                    Object.keys(rawStore || {}).forEach(k => {
                        if (!internalKeys.includes(k)) {
                            try {
                                data[k] = JSON.parse(JSON.stringify(deepRaw(rawStore[k])));
                            }
                            catch {
                                data[k] = String(rawStore[k]);
                            }
                        }
                    });
                    obj[key] = data;
                });
                return { found: true, value: obj };
            }
            return { found: true, value: val };
        }
        catch (e) {
            return { found: false, message: String(e) };
        }
    });
}
// 注册 MCP 工具：获取交易上下文信息
server.registerTool("get_trade_info", {
    title: "获取交易上下文信息",
    description: "返回交易上下文信息，以及用户暂存的数据，帮助理解当前用户的状态和需求",
    inputSchema: z.object({}),
}, async () => {
    try {
        const page = await connectToElectron();
        const info = await getX5PiniaS(page);
        if (!info || info.found === false) {
            return {
                content: [
                    { type: "text", text: `❌ 未找到 x5 Pinia _s：${info?.message || '未定义'}` }
                ],
                isError: true,
            };
        }
        return {
            content: [
                { type: "text", text: JSON.stringify(info.value, null, 2) }
            ]
        };
    }
    catch (error) {
        return {
            content: [{ type: "text", text: `❌ 获取 x5 Pinia _s 失败: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
        };
    }
});
// ═══════════════════════════════════════════════════════════════
//  工具2: 填写输入框
// ═══════════════════════════════════════════════════════════════
/**
 * 在输入框中填写文本内容
 */
server.registerTool("fill_input", {
    title: "填写输入框",
    description: "在指定的输入框中填写内容，支持使用 CSS selector 或元素属性定位",
    inputSchema: z.object({
        selector: z.string().describe("CSS 选择器，例如 #username、input[name='email']、.input-field"),
        value: z.string().describe("要填写的文本内容"),
        clearFirst: z.boolean().optional().describe("填写前是否先清空原有内容，默认为 true"),
        delay: z.number().optional().describe("逐字输入的延迟（毫秒），默认为 30ms"),
    }),
}, async ({ selector, value, clearFirst = true, delay = 30 }) => {
    try {
        const page = await connectToElectron();
        // 等待元素出现
        await page.waitForSelector(selector, { timeout: 5000 });
        if (clearFirst) {
            // 聚焦元素
            await page.focus(selector);
            // 全选内容
            await page.evaluate(() => {
                const el = document.activeElement;
                if (el)
                    el.select?.();
            });
            // 删除
            await page.keyboard.press("Backspace");
        }
        // 逐字输入文本
        await page.type(selector, value, { delay });
        return {
            content: [
                {
                    type: "text",
                    text: `✅ 成功填写 "${selector}":\n内容: ${value}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `❌ 填写输入框失败: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
});
// ═══════════════════════════════════════════════════════════════
//  工具3: 点击元素
// ═══════════════════════════════════════════════════════════════
/**
 * 点击页面上的按钮或其他元素
 */
// server.registerTool(
//   "click_element",
//   {
//     title: "点击元素",
//     description: "点击页面上的指定元素，支持 CSS selector 定位或按文字匹配",
//     inputSchema: z.object({
//       selector: z.string().optional().describe("CSS 选择器，例如 #submit-btn、.confirm-button、button[type='submit']"),
//       text: z.string().optional().describe("元素的文字内容，用于当不知道 selector 时的模糊匹配"),
//       times: z.number().optional().describe("点击次数，默认为 1"),
//       delay: z.number().optional().describe("多次点击之间的延迟（毫秒），默认为 100ms"),
//     }),
//   },
//   async ({ selector, text, times = 1, delay = 100 }) => {
//     try {
//       const page = await connectToElectron();
//       let clickTarget = selector;
//       // 如果没有提供 selector，通过文字内容查找
//       if (!selector && text) {
//         const found = await page.evaluate((btnText) => {
//           const elements = document.querySelectorAll("button, a, [role='button'], [role='link'], input[type='button'], input[type='submit']");
//           for (const el of elements) {
//             const htmlEl = el as HTMLElement;
//             const inputEl = el as HTMLInputElement;
//             const elementText = htmlEl.innerText?.trim() || inputEl.value?.trim() || "";
//             if (elementText.toLowerCase().includes(btnText.toLowerCase())) {
//               // 返回第一个匹配的元素的唯一标识符
//               if (htmlEl.id) return `#${htmlEl.id}`;
//               // 如果没有 ID，返回标签名和位置
//               const siblings = Array.from(htmlEl.parentElement?.children || []);
//               const index = siblings.indexOf(htmlEl);
//               return `${htmlEl.tagName.toLowerCase()}:nth-child(${index + 1})`;
//             }
//           }
//           return null;
//         }, text);
//         if (!found) {
//           throw new Error(`找不到文字包含 "${text}" 的元素`);
//         }
//         clickTarget = found;
//       } else if (!selector) {
//         throw new Error("必须提供 selector 或 text 参数");
//       }
//       // 等待元素出现
//       if (!clickTarget) {
//         throw new Error("无法确定点击目标");
//       }
//       await page.waitForSelector(clickTarget, { timeout: 5000 });
//       // 多次点击
//       for (let i = 0; i < times; i++) {
//         await page.click(clickTarget);
//         if (i < times - 1) {
//           await new Promise(resolve => setTimeout(resolve, delay));
//         }
//       }
//       return {
//         content: [
//           {
//             type: "text",
//             text: `✅ 成功点击 "${selector || text}"${times > 1 ? `（${times} 次）` : ""}`,
//           },
//         ],
//       };
//     } catch (error) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: `❌ 点击失败: ${error instanceof Error ? error.message : String(error)}`,
//           },
//         ],
//         isError: true,
//       };
//     }
//   }
// );
// ═══════════════════════════════════════════════════════════════
//  工具4: 读取元素内容
// ═══════════════════════════════════════════════════════════════
/**
 * 读取页面元素的文本内容或属性值
 */
// server.registerTool(
//   "read_element",
//   {
//     title: "读取元素内容",
//     description: "读取页面上指定元素的文字内容、属性值或表单值",
//     inputSchema: z.object({
//       selector: z.string().describe("CSS 选择器"),
//       attribute: z.string().optional().describe("要读取的属性名（如 'value'、'href'、'data-id'），留空则读取文字内容"),
//       returnType: z.enum(["text", "value", "attribute", "all"]).optional().describe("返回类型，默认为 text"),
//     }),
//   },
//   async ({ selector, attribute, returnType = "text" }) => {
//     try {
//       const page = await connectToElectron();
//       // 等待元素出现
//       await page.waitForSelector(selector, { timeout: 5000 });
//       const result = await page.evaluate(
//         (sel, attr, type) => {
//           const el = document.querySelector(sel);
//           if (!el) return null;
//           const htmlEl = el as HTMLElement;
//           const inputEl = el as HTMLInputElement;
//           const result: Record<string, any> = {};
//           if (type === "all") {
//             result.text = htmlEl.innerText?.trim();
//             result.value = inputEl.value;
//             result.html = htmlEl.innerHTML;
//             result.attributes = {};
//             htmlEl.getAttributeNames().forEach((name) => {
//               result.attributes[name] = htmlEl.getAttribute(name);
//             });
//             return result;
//           }
//           if (type === "value" || attr === "value") {
//             return inputEl.value;
//           }
//           if (type === "attribute" && attr) {
//             return htmlEl.getAttribute(attr);
//           }
//           return htmlEl.innerText?.trim() || inputEl.value || htmlEl.textContent?.trim();
//         },
//         selector,
//         attribute ?? null,
//         returnType
//       );
//       return {
//         content: [
//           {
//             type: "text",
//             text: result !== null
//               ? `📄 元素 "${selector}" 的内容:\n${JSON.stringify(result, null, 2)}`
//               : `❌ 未找到元素: ${selector}`,
//           },
//         ],
//       };
//     } catch (error) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: `❌ 读取失败: ${error instanceof Error ? error.message : String(error)}`,
//           },
//         ],
//         isError: true,
//       };
//     }
//   }
// );
// ═══════════════════════════════════════════════════════════════
//  工具5: 等待元素
// ═══════════════════════════════════════════════════════════════
/**
 * 等待指定的元素出现或消失
 */
// server.registerTool(
//   "wait_for_element",
//   {
//     title: "等待元素",
//     description: "等待指定的元素出现或消失，用于同步页面加载状态",
//     inputSchema: z.object({
//       selector: z.string().describe("CSS 选择器"),
//       visible: z.boolean().optional().describe("true 表示等待元素出现，false 表示等待元素消失，默认为 true"),
//       timeout: z.number().optional().describe("超时时间（毫秒），默认为 5000"),
//     }),
//   },
//   async ({ selector, visible = true, timeout = 5000 }) => {
//     try {
//       const page = await connectToElectron();
//       if (visible) {
//         await page.waitForSelector(selector, { timeout });
//       } else {
//         await page.waitForSelector(selector, { hidden: true, timeout });
//       }
//       return {
//         content: [
//           {
//             type: "text",
//             text: `✅ 元素 "${selector}" 已${visible ? "出现" : "消失"}`,
//           },
//         ],
//       };
//     } catch (error) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: `❌ 等待超时: ${error instanceof Error ? error.message : String(error)}`,
//           },
//         ],
//         isError: true,
//       };
//     }
//   }
// );
// ═══════════════════════════════════════════════════════════════
//  工具6: 执行 JavaScript
// ═══════════════════════════════════════════════════════════════
/**
 * 在页面中执行自定义 JavaScript 代码
 */
// server.registerTool(
//   "execute_script",
//   {
//     title: "执行 JavaScript",
//     description: "在 Electron 页面中执行自定义 JavaScript 代码，用于复杂的页面交互",
//     inputSchema: z.object({
//       script: z.string().describe("要执行的 JavaScript 代码，最后一条表达式作为返回值"),
//       args: z.array(z.any()).optional().describe("传递给脚本的参数数组"),
//     }),
//   },
//   async ({ script, args = [] }) => {
//     try {
//       const page = await connectToElectron();
//       const result = await page.evaluate(
//         (scriptCode: string, ...params: any[]) => {
//           try {
//             // 创建函数并执行
//             const fn = new Function(...params.map((_, i) => `arg${i}`), `return (${scriptCode})`);
//             return fn(...params);
//           } catch (e) {
//             return { error: String(e) };
//           }
//         },
//         script,
//         ...args
//       );
//       return {
//         content: [
//           {
//             type: "text",
//             text: `✅ 脚本执行成功:\n${JSON.stringify(result, null, 2)}`,
//           },
//         ],
//       };
//     } catch (error) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: `❌ 脚本执行失败: ${error instanceof Error ? error.message : String(error)}`,
//           },
//         ],
//         isError: true,
//       };
//     }
//   }
// );
/**
 * 获取当前页面的基本信息
 */
// server.registerTool(
//   "get_page_info",
//   {
//     title: "获取页面信息",
//     description: "获取当前页面的基本信息，如标题、URL、页面尺寸等",
//     inputSchema: z.object({}),
//   },
//   async () => {
//     try {
//       const page = await connectToElectron();
//       const info = await page.evaluate(() => {
//         return {
//           title: document.title,
//           url: location.href,
//           width: window.innerWidth,
//           height: window.innerHeight,
//           readyState: document.readyState,
//           elementCount: document.querySelectorAll("*").length,
//           formCount: document.querySelectorAll("form").length,
//           buttonCount: document.querySelectorAll("button").length,
//           inputCount: document.querySelectorAll("input").length,
//         };
//       });
//       return {
//         content: [
//           {
//             type: "text",
//             text: `📋 页面信息:\n${JSON.stringify(info, null, 2)}`,
//           },
//         ],
//       };
//     } catch (error) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: `❌ 获取页面信息失败: ${error instanceof Error ? error.message : String(error)}`,
//           },
//         ],
//         isError: true,
//       };
//     }
//   }
// );
// ═══════════════════════════════════════════════════════════════
//  工具8: 截图
// ═══════════════════════════════════════════════════════════════
/**
 * 对当前页面进行截图
 */
// server.registerTool(
//   "take_screenshot",
//   {
//     title: "截图",
//     description: "对当前 Electron 页面进行截图，返回 base64 编码的图片",
//     inputSchema: z.object({
//       fullPage: z.boolean().optional().describe("是否截整个页面，默认为 false 只截可见区域"),
//       quality: z.number().optional().describe("JPEG 质量（0-100），默认为 80"),
//     }),
//   },
//   async ({ fullPage = false, quality = 80 }) => {
//     try {
//       const page = await connectToElectron();
//       const screenshot = await page.screenshot({
//         fullPage,
//         quality,
//         type: "jpeg",
//       });
//       const base64 = screenshot.toString("base64");
//       return {
//         content: [
//           {
//             type: "image",
//             data: base64,
//             mimeType: "image/jpeg",
//           },
//           {
//             type: "text",
//             text: `✅ 截图成功（${screenshot.length} 字节）`,
//           },
//         ],
//       };
//     } catch (error) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: `❌ 截图失败: ${error instanceof Error ? error.message : String(error)}`,
//           },
//         ],
//         isError: true,
//       };
//     }
//   }
// );
// ═══════════════════════════════════════════════════════════════
//  工具9: 刷新页面
// ═══════════════════════════════════════════════════════════════
/**
 * 刷新当前页面
 */
// server.registerTool(
//   "refresh_page",
//   {
//     title: "刷新页面",
//     description: "刷新当前 Electron 页面",
//     inputSchema: z.object({
//       hard: z.boolean().optional().describe("是否执行硬刷新（清除缓存），默认为 false"),
//     }),
//   },
//   async ({ hard = false }) => {
//     try {
//       const page = await connectToElectron();
//       if (hard) {
//         await page.reload({ waitUntil: "networkidle2" });
//       } else {
//         await page.reload({ waitUntil: "load" });
//       }
//       return {
//         content: [
//           {
//             type: "text",
//             text: `✅ 页面已${hard ? "硬" : ""}刷新`,
//           },
//         ],
//       };
//     } catch (error) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: `❌ 刷新失败: ${error instanceof Error ? error.message : String(error)}`,
//           },
//         ],
//         isError: true,
//       };
//     }
//   }
// );
// ═══════════════════════════════════════════════════════════════
//  启动 MCP Server
// ═══════════════════════════════════════════════════════════════
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("✅ Electron MCP Server 已启动，等待连接...");
}
main().catch((err) => {
    console.error("❌ 启动失败：", err);
    process.exit(1);
});
