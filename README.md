# dsh-wip-codegen-agent

一个 **DSH Agent bundle**：把「WIP（在制品）/ HRP（人事）代码生成规范」注册成一个可选的 Agent 预设。

装上去，**新开对话选「WIP/HRP 代码生成」**即可用；卸掉，它干干净净消失。

- 不注册任何 Tool，没有 Client 半边，**零依赖**；
- 提示词正文是仓库里一份普通 Markdown（`assets/wip-codegen/system-prompt.md`），**改完弹框确认即可热加载**，不用重装（见下方「改规范正文」）；
- 装/卸靠一行插件行，**真热插拔**（见下方「为什么说热插拔」）。

## 这个 Agent 能做什么

| 能力 | 说明 |
|---|---|
| **SQL Server 建表脚本生成** | 给字段清单 / 界面截图 / Excel 样例 / 自然语言描述，产出可直接执行的建表脚本：存在则删除 → CREATE TABLE（行内注释）→ 每字段 `sp_addextendedproperty` → 表注释 → 索引建议 → 末尾注释掉的删表语句；表名/主键/字段/类型/审计字段/索引全部按规范。可选在指定目录生成 `.sql` 文件（`wip-20261011-任务安排表-未测试-未发生产.sql`） |
| **Java 代码生成** | Spring Boot 3 + MyBatis-Plus：实体、Req/Resp、Import/Export、Mapper + XML、Service + ServiceImpl、Controller |
| **先确认再落地（红线）** | SQL 出草案后必须**逐个字段**与用户确认（补充/删除/修改）才写文件；代码生成前先问「一次性全部 / 逐个类确认」，逐个模式每生成一个类就停下确认；**任何删除（文件/类/字段/方法/表）必须先确认**才执行 |
| **复制现有 Controller 风格** | 先把一个已存在的 Controller 定为「风格基准类」，**真实读源码**抽出包/注解/注入/命名/返回包装/日志/注释风格，之后每个类都按它复制；与规范冲突时以基准类为准并说明 |
| **全局规则沉淀** | 用户说「以后都这样 / 全局都要 / 加到规范里」→ Agent 把规则追加进正文 §十五「全局规则（用户追加）」，**写完弹框确认即可热加载**，不需要重装插件 |
| **规则冲突先问** | §十五 与 §二～§六 冲突时不自行裁决：先列「被覆盖的条目 + 覆盖理由」，让你选覆盖 / 并存 / 放弃，确认后才写进 §十五 并标注「覆盖 §x.y」 |
| **接口测试（内置 api-test 技能）** | 挂载 `dsh-api-test-bundle`：本地联调 HTTP/SOAP/RPC/MQ/Spring Integration/本地方法，测试完**必出主流格式测试用例**（Markdown + 真 `.xlsx`）、**接口返回字段来源关系图**、调用链路图与 UML 类图；参数只在正常区间变更，代码已显式校验的错误参数不再重复造用例 |

## 安装

**两个插件都要装**，且建议先装测试插件：

```
action: install_bundle
target: github:yuanli-6/dsh-api-test-bundle

action: install_bundle
target: github:yuanli-6/dsh-wip-codegen-agent
```

只装本插件也能用（代码生成 + SQL 生成照常），但**接口测试那两行会自动降级掉**：
预设里引用一个装不上的包会让整条预设激活失败（见「两个真实的坑」），所以插件会先探测
`dsh-api-test-bundle` 是否可解析，解析不到就只记一条警告、不挂那两行。

锁定版本：`github:yuanli-6/dsh-wip-codegen-agent#v2.4.0`。
本地改代码时用目录安装：`action: install_bundle, target: <本目录绝对路径>`。

装完**新开一个对话**，预设选择里就能看到 **WIP/HRP 代码生成**。

> 插件属于**本机 profile**（`$DSH_HOME/profiles/<profile>/`），不属于 DSH 账号。
> 换机器需要重新执行一次上面的安装——这正是走 GitHub 的意义。

### 装之前要先做一件事（重要）

如果你之前在 **设置 → Agent 中心** 里手工建过同名预设，**先把它删掉**。

同一个 preset id 全局只能注册一次。两边都注册 `wip-codegen` 时，后到的那个会失败并报
`Duplicate agent preset`。这个报错只在日志里、不影响别的插件，所以现象是"装了但没反应"。

---

## 用它

1. 新建对话 → 预设选 **WIP/HRP 代码生成**；
2. 按需要丢给它：**字段清单 / 界面截图 / Excel 样例**（→ 先出建表脚本）、
   **已建好的建表 SQL**（→ 直接出代码）、**一个现有 Controller**（→ 作为风格基准）；
3. 顺着它的问题走：
   - SQL：它先给草案，再问你每个字段要不要**补充/删除/修改**，确认后才问要不要生成 `.sql` 文件；
   - 代码：它先问**一次性全部 / 逐个类确认**（推荐逐个），再按你选的节奏逐类确认；
   - 想让它以后都按某条规则来：直接说「以后都这样」，它会写进正文 §十五。

### 它被配成什么样

**系统提示词**：本包自带的 `persona-hot.js` 在 `deployment:persona-prefix` 段上承载规范全文，并且 `complete: true`。

`complete: true` 是平台第一方表达「这段就是完整系统提示词」的方式。含义是：
**只有这份规范进上下文**，记忆导引、team 政策、plan 政策、其他插件的工具指引都不会再注入。
规范本身是强制性的（"必须严格遵守"），稀释它没有好处。工具 schema 照常下发，
工具也照常可调用。

注意 `complete: true` **不会**让任意 `{{…}}` 名字变得合法：循环只注册 `provider` 与
`model` 两个变量，任何其他引用都会让提示词组装直接抛 `unknown prompt variable`，
这一轮的模型请求根本发不出去（表现为「本轮运行失败」）。所以正文末尾只注入
**规范正文绝对路径**一行；工作目录由平台的工作目录服务以「必需」运行时上下文
（`Current working directory: …`）提供，`complete: true` 也压不掉，既不需要、
也不能再写成模板变量。

> 规范正文路径那行是给 §14.6 用的：Agent 要把你提出的全局规则追加进正文 §十五，
> 它必须知道那个文件在哪。路径由插件在激活时算出，不写死在任何地方。

**行清单**（`index.js` 的 `buildDefinition()`）：

| 行 | 为什么给 |
|---|---|
| `dsh-wip-codegen-agent/persona-hot` | 承载规范正文（`complete: true`）；正文是函数，每步重读文件，改完弹框确认即生效 |
| `@deepseek-ai/dsh-agent-instructions` | 把 `AGENTS.md` 读成一条 user 消息（`maxBytes: 65536`）；**没有它，仓库里的 `AGENTS.md` 根本不生效** |
| `dsh-wip-codegen-agent/project-index` | 复合索引引擎 + 30 分钟后台监听器 + `project_index` 工具；**没有它，§十七 的索引优先工作流无从执行** |
| `@deepseek-ai/dsh-tool-skill` | 渲染技能目录 + 提供 `skill` 加载工具；**没有它，内置的 api-test 技能永远加载不了** |
| `dsh-api-test-bundle` | 接口测试技能本体（可选，装不到就自动不挂） |
| `delegation` 组（6 行） | `subagent` / `subagent_fork` / `workflow` + 三个控制行；一次调用扇出多个子上下文，**只回结论、不回原文** |
| `tool-fs` / `tool-fs-search` | 读 SQL/样例/基准类、写生成出的代码 |
| `pwsh`（Windows）/ `bash`（其他） | 跑构建、看目录 |
| `tool-ask-user` | **§十四 的确认流程全靠它**（没有它就无法"先确认再落地"） |
| `tool-todo` | §十 的输出顺序 + 逐类确认的进度 |

**刻意不给**，都有理由：

- `ralph` —— 这个 Agent 的循环由 §十 固定，不需要另一套自转；
- `memory_*` —— 规范与记忆无关；
- `plugin_manager` —— 不许它改插件；
- `plan-mode` —— 它只注册一段提示词和 `exit_plan_mode` 工具，**不做任何工具拦截**；
  而本预设的 persona 是 `complete: true`，组装时其余段落全部丢弃，那段引导进不来，
  挂上去只剩一个 `/plan` 开关，行为一点不变。

> v1.x 曾经刻意不给 `skill`（省 token）。v2.0.0 改了：既然是"把这个插件配置到这个 agent 里"，
> 就必须有目录与加载工具，否则技能注册了也没人看得见。代价是一条技能描述（上限 400 字符）。

> v1.x～v2.3.0 刻意不给 `subagent` / `workflow`，理由是"这个 Agent 是写代码的，不派活"。
> v2.4.0 推翻了它：**大型项目多文件变更时，真正的成本是每个文件都要在主线里被完整读一遍**。
> 子代理把 N 次读盘变成 N 个独立上下文，主线只收摘要；`workflow` 则让一次调用并发扇出。
> 两者都不改规范，只改"谁去读"。

> **v2.0.1 修的是 v2.0.0 的致命 bug**：正文末尾曾注入 `工作目录：{{cwd}}`，
> 而平台的提示词循环只注册 `provider` / `model` 两个变量，于是每次模型请求都在
> `deployment:persona-prefix` 段组装失败（`unknown prompt variable "{{cwd}}"`）。
> 修法不是换变量名，而是**删掉那一行**：工作目录本来就由工作目录服务以必需运行时上下文
> （`Current working directory: …`）下发，`complete: true` 压不掉它，重述一遍既多余又致命。
> 用 v2.0.0 的请按「发布新版本」的三步升级。

> **v2.3.0 加了热加载**：persona 行从 `@deepseek-ai/dsh-persona` 换成自带的 `persona-hot.js`，
> 正文改完弹框确认即可生效，不用重装（见「改规范正文」）。顺带给 §十五 加了一条强制约束：
> 全局规则与 §二～§六 冲突时必须先问，不得自行裁决。

> **v2.4.0 加了三个必需字段之外的协作能力**：`agent-instructions`（让 `AGENTS.md` 真正生效）、
> `delegation` 组（`subagent` / `subagent_fork` / `workflow`）、以及 §十六 里一条关于
> 「大范围查阅先派子代理」的使用规则。起因是「大型项目多文件变更时，每查一个文件都要重复思考」——
> 根因是文件原文进了主线上下文就不再释放，子代理把这件事挪出主线。`plan-mode` 经实测**没挂**：
> 它不拦截任何工具，而 `complete: true` 会丢弃它的提示词段，挂上去等于没有。

> **v2.5.0 加了复合索引**：新增 `project-index.js`（引擎 + 30 分钟租约监听器 + `project_index` 工具）
> 与 §十七。主会话先查索引、只按需读源码，取代 v2.4.0「大范围查阅先派子代理」作为默认路径 ——
> 派子代理仍然是索引回答不了时的手段，但它不再是第一反应。
> 索引条目按**文件内容 sha256** 判定可信度（`action=verify`），不是按索引新旧。

> **v2.5.1**：`action=read` 的输出里直接带上该文件的 `sha256`。原来「要结构」和「要凭证」是两次
> 调用（先 `read` 再 `verify`），现在一次就够 —— 少一次往返，也少一个「忘了 verify 就直接信」的机会。

> **v2.6.0 把索引从「骨架」补成「可定位」**（`INDEX_VERSION` 1 → 2，旧 `file-cache.json` 自动作废）：
>
> - **行号**：类、字段、方法、常量、枚举值、构造器、业务规则全部带 1-based 行号。`query` 与 `read`
>   的每条输出都能直接落到源码某一行，不必再 grep 找位置。实测 3386 条 Java 规则 + 251 条 XML
>   语句逐条比对源码，`bad=0`。
> - **常量 / 枚举值 / 构造器**：`public interface` 的隐式常量（`String KEY = "..."`）、`enum` 的枚举项
>   与参数、构造器签名都进索引。改造前这三类**完全不被收录** —— `WipConstant.java` 是 0 字段，
>   `BusinessType.java` 是 0 字段，而它们恰恰是字典口径的唯一来源。
> - **注解参数值**：`@RequestMapping("/taskArrangement")`、`@PostMapping("/getByPage")`、
>   `@Operation(summary = "…")`、`@TableId/@TableField(value = "…")`、`@Schema(description = "…")`
>   的参数不再被丢弃。改造前索引只知道「有个 RequestMapping」，不知道它服务哪个 URL。
> - **跨文件关系**：`import`（12070 条）、`relations`（4882 条，72% 解析出本项目路径）、
>   Mapper 接口 ↔ XML 双向互指（`mapper_interface` / `mapper_xml`）。
> - **字段中文说明**回退到 `@Schema(description)`：全库空注释 58.5% → 25%，实体与 Req 52.8% → 7%。

### 复合索引：先查索引，再决定读不读源码（v2.5.0 起）

规范 §十七 要求：回答项目结构 / 业务逻辑类问题前，**先查索引**；命中且**文件 hash 未变**时用
`directory_index` 定位文件、用 `methods` / `logic_details` 拿逻辑，**除非用户明确要求改源码，
否则不全量读源码**。这条规则要落地，缺的从来不是提示词，而是那份索引本身 —— 没人维护的索引
一天就过期，过期索引比没有索引更坏（它会自信地给出错答案）。

落盘位置由规范钉死，就在**项目根目录**下（不是插件安装目录）：

```
<项目根>/.dsh/index/project_index.json   # 三块：project_meta / directory_index / content_logic_index
<项目根>/.dsh/index/file-cache.json      # 旁挂：每个文件的 size + mtime + sha256（增量记账）
```

`project_index.json` 严格只有规范要求的三块 —— 但每个 `directory_index` 子项额外带一个 `hash`
字段（该文件内容的 sha256）。它不属于规范的三块结构之外的新块，只是文件条目上的一个属性，
而且是**可信度的唯一凭证**：模型靠它判断「这条索引还对不对」。

`file-cache.json` 是增量的记账（size + mtime + sha256，用来决定要不要重读），与 `hash` 各司其职：
前者省 IO，后者给模型凭证。两者都**不会被重装插件覆盖**。

**可信度看 hash，不看时间**。`last_updated` 只说明索引什么时候建的，不说明条目还对不对：
一秒前建的索引，若那个文件刚被改过而监听器还没跑，条目照样是旧的；反过来，三小时没重建的
索引，只要文件没动过，条目就完全正确。所以 §17.2 把判据定成：

- `action=verify` 报 **hash 一致** ⇒ 索引描述的就是当前这份文件。可以直接回答，**也可以直接
  基于它改源码** —— 不必先全量读一遍，只读要改的那几行。
- **hash 不一致** ⇒ 这一条已过期，改源码前必须自己读该文件。
- 条目里没有 `hash`（旧版索引）⇒ 按不可信处理，`action=build` 一次补齐。

`action=read` 的输出里**直接带着该文件的 `sha256`**：想同时要结构和可信凭证时一次调用就够，
不必 `read` 完再补一次 `verify`。`verify` 留给「只关心 hash、不要结构」的场合。

这也是为什么监听器的 30 分钟租约只管「什么时候该重新扫一遍」，**不参与可信度判断**。

**为什么不是真子代理**。规范原文说「后台监听器子代理」，本实现是 Host 插件里的后台任务
（`setInterval` + `fs.watch`），没有拉起模型。理由：

- 子代理继承本预设，一次拉起就是一份 40 KB 规范进上下文，按 30 分钟一次算是纯浪费；
- `delivery: 'parent'` 会把子代理的结果作为消息投进主会话，**必然**打断「静默」这个前提；
- 子代理同样会继承 `project-index` 行，于是会递归拉起监听器，得再加闸门；
- 模型驱动的解析结果不确定 —— 索引这种要长期被信任的东西，不该每次都长得不一样。

所以「监听器」的职责边界（全量构建 / 增量更新 / 冲突跳过）一条没少，只是执行者是确定性 JS。

**监听器做什么**：

| 时机 | 动作 |
|---|---|
| 主会话第一次 step（`agent/pre-step`） | 后台静默启动，**不阻塞该 step**；索引缺失就全量建，存在且租约未过期就什么都不做 |
| 每次 step | 检查租约。过期（30 分钟）才重新扫一遍，未过期直接返回 |
| 文件变化（`fs.watch`，递归 + 1.2 s 防抖） | 增量：只重解析 size/mtime/sha256 有变化的文件 |
| 构建时撞上正在写的文件 | 该文件跳过，保留旧条目，并在 2.7 s 后自动补建一次 |

最后一行是实测出来的坑：防抖窗口里的写入会落在「刚改完、还在写」的判定内被跳过，
而那一批 watch 事件已经用完了 —— 没有补建的话索引会一直旧到租约到期。

**主会话怎么用**：`project_index` 工具五个动作 —— `status`（索引在不在、新不新）、
`query`（按路径/类名/方法名/业务规则检索）、`read`（读某文件的结构化条目，输出里带 `sha256`，
`symbol` 可收窄到单个类或方法）、`verify`（只比对 hash，改源码前用）、`build`（强制全量，
通常不必手动调）。
工具**不等待构建**：索引缺失时它直接说明现状，主会话改用 `grep`/`glob`/`read` 回答当前问题，
同时告诉用户「已触发后台索引构建，当前我先基于原生检索为您解答」。

**解析到什么程度**（Java / XML 走结构解析，其余语言取首段注释）：

| 键 | 内容 |
|---|---|
| `package` / `imports` | 包名；`import` 全限定名（上限 80 条，`import static` 与 `*` 通配都收） |
| `classes` | `name`、`kind`（class/interface/enum/record/mapper）、`extends`、`implements`、`annotations` + `annotation_args`、`line`、Javadoc 摘要；interface 带 `constants`，enum 带 `enum_values` |
| `fields` | `name`、`type`、`comment`、`column`（`@TableId/@TableField` 列名）、`value`（`static final` 的字面量）、`annotations` + `annotation_args`、`line` |
| `constructors` | `name`、`parameters`、`annotations` + `annotation_args`、`line`。**刻意独立于 `methods`**：构造器没有返回类型，混进方法表会污染「返回类型」这一列 |
| `methods` | `name`、`"类型 参数名"` 参数表、`return_type`、`logic_summary`、`key_dependencies`、`annotations` + `annotation_args`、`line` |
| `relations` | `{to, kind}` 引用清单（`extends`/`implements`/`field`/`return`/`parameter`），全量解析后统一回填 `path` |
| `logic_details` | 方法体里的 `if (条件) → 动作` 逐条成规则，带 `line`；MyBatis XML 则一条语句一条规则（带 `result_type`、`parameter_type`、`line`） |

`annotation_args` 存的是**原始参数文本**（截断到 300 字符），不是解析后的结构 —— 注解参数写法
太自由（命名参数、位置参数、数组、嵌套注解），存原文让 `query` 能直接按 URL 或列名命中，需要细看
时再自己解读。

`relations` 会**过滤掉 JDK 类型**（`String`/`Long`/`List`/`Map` 等）：不过滤的话一个 Service 的
引用名额会被它们占满，真正的项目类反而挤不进来 —— 实测过滤前解析率 29%，过滤后 72%。
按名字解析只能当提示：同简单名跨包时先到先得，有 `import` 时以 `import` 为准。

摘要优先取 Javadoc，没有才退回声明/首条语句；字段注释优先取 Javadoc，没有才回退到
`@Schema(description = …)` —— 团队写实体和 Req 用 `@Schema` 而不写 Javadoc，不回退的话
一半以上字段没有中文说明。`// ===== 横幅 =====` 这类装饰性注释会被剥掉
（保留文字、丢掉等号），因为本仓库到处都是它。

**成本**：全量建一次 `wip-srv`（1698 文件 / 1517 个 Java）约 24 秒，纯 CPU、零 token；
之后靠增量，改一个文件只重解析一个文件。监听器全程 `unref()`，进程不会因它不退出。

### `AGENTS.md` 怎么生效（v2.4.0 起）

`agent-instructions` 把说明文件读成一条 **user 消息**（`<system-reminder>` 包裹），不是提示词段落。
这一点很关键：**user 消息不受 `complete: true` 影响**，所以它能和本 Agent 的完整 persona 共存。

读哪些文件（配置里没写就按默认）：

| 范围 | 路径 |
|---|---|
| 用户全局 | `$DSH_HOME/AGENTS.md`（即 `C:\Users\GSH\.dsh\AGENTS.md`）与 `$DSH_AGENTS_HOME/AGENTS.md`；两者内容相同时只渲染一次 |
| 项目 | 从 `findProjectRoot(cwd, [".git"])` 找到的项目根起，沿 `ancestorChain(projectRoot, cwd)` **逐级向下**读每一级的 `AGENTS.md` / `CLAUDE.md` 与 `AGENTS.local.md` / `CLAUDE.local.md` |

⚠️ **项目根由 `.git` 决定，向上查找到项目根就停。** 如果 `wip-srv` 自己是一个 git 仓库，
那么放在上一级 `C:\dDir\java-project\AGENTS.md` 的内容**永远不会被读到**——这种情况要用全局那份，
或者放进各仓库自己的 `AGENTS.md`。

文件改动会被重新读取（按内容摘要比对），不需要重启。

### 什么时候该派子代理

规范 §十六 里那条规则的要点：**需要看 3 个以上文件、且只要结论不要原文时，派子代理或 `workflow`。**
典型场景是"找出所有调用 X 的地方""这个字段在哪些表里出现过""这几份 Mapper XML 的排序口径一致吗"。
反过来，**正在写的那一个文件必须自己读**——子代理返回的摘要不足以支撑逐行修改。

代价要说清楚：每个子代理都是一次独立的模型调用，扇出 N 个就是 N 份 token。
它省的是主线上下文的**持续占用**，不是总开销。

v2.5.0 起先查索引：上面那几个典型场景**多数能直接用 `project_index` 的 `query` 回答**，
不必派子代理。索引回答不了的（需要读具体实现细节、需要跨文件比对代码风格）才派子代理。

### 三个必需的配置字段（别删）

`tool-fs-search` 的 `sampleOverCapGlobResults`、`tool-todo` 的 `allowParallelInProgress`、
`agent-instructions` 的 `maxBytes` 在本版 DSH 里是**必填且无默认值**。少一个，激活审计就会否掉整条预设：

> 现象是预设变成 `broken`、**选都选不了**，而报错只出现在预设的 `broken` 字段里。

v1.x 正是漏了前两个字段，所以那个版本**从来没有真正可用过**（离线自检全绿，因为离线看不到配置契约）。
现在 `index.js` 里三行都带上（值取自平台自带的 `standard` 预设），`verify.mjs` 也会断言它们，
`verify-runtime/run.mjs` 则在真实安装上验证预设不 broken。

---

## 为什么说热插拔

`cordis.patch.yml` 只做一件事：往 profile 的 loader 树里插一行。

```yaml
- insert:
    - id: dsh-wip-codegen-agent
      name: 'dsh-wip-codegen-agent'
```

插件加载时调 `ctx.agentPresets.register(...)`，拿到 disposer 并挂进 `ctx.effect`；
**卸载时调用它**，预设随之注销。所以：

- 禁用这一行 → Agent 消失；重新启用 → 回来。**不必重启 DSH**；
- 这行不在 profile 里，插件代码根本不会被加载，预设也不会存在。

两条容易踩的时序坑，代码里都处理了（`verify-lifecycle.mjs` 有对应用例）：

1. `register()` 是异步的。若插件在它 resolve 之前就被卸载，回调里会**自己 dispose 掉自己**——
   否则会留下一个"运行时在、但没人持有"的幽灵预设，下次启动重放就撞 Duplicate；
2. 注册失败**只记日志、不抛异常**。这段跑在宿主的激活事务里，抛出去会连累无关插件。

---

## 改内容

### 改规范正文（含 §十五 全局规则）

改 `assets/wip-codegen/system-prompt.md`，保存后**插件会弹出确认框**：

```
规范正文已修改
检测到规范正文已修改（24034 → 24180 字符）。是否立即热加载？
  [立即热加载]  从下一步起使用新正文
  [稍后再说]    继续使用当前正文；再次修改文件会重新保存并重新询问
```

点 **立即热加载** 就生效——**不用重装、不用 toggle、不用重启 DSH**。

热加载为什么能生效：`index.js` 不再挂 `@deepseek-ai/dsh-persona`（它把正文当**配置字符串**收下，
而预设配置在挂载时会被 `structuredClone`，正文因此被钉死在激活那一刻），改挂本包自带的
`persona-hot.js`。它注册**同名同序**的 `deployment:persona-prefix` 段，但 `text` 是一个**函数**——
提示词注册表每次组装都会重新调用它（`text: typeof section.text === "function" ? section.text(context) : section.text`），
而组装每个 agent step 跑一次，所以函数里重读文件就等于正文常驻最新。

几个要说清楚的行为：

| 场景 | 行为 |
|---|---|
| 保存文件 | 监视器防抖 400ms 后读盘；内容没变则不弹框 |
| 读到的内容含 `规范正文未能读取` | 判为「编辑器正在截断写入」，**拒绝采纳**，继续用当前正文 |
| 点了「稍后再说」 | 丢弃这次变更；**下次再改文件会重新弹框** |
| 当前没有活着的 root agent（如刚启动） | 只记一条日志，等下一个请求开始时再弹框 |
| 宿主没有问答服务（headless） | 记一条警告后**丢弃变更**，不会每步重问；此时仍需重装 |
| 生效时机 | 组装 step N 发生在 `agent/pre-step` for step N **之前**，所以确认后从 **step N+1** 起生效 |

> 监视的是**已安装副本**（`$DSH_HOME/profiles/<profile>/node_modules/dsh-wip-codegen-agent/assets/wip-codegen/system-prompt.md`），
> 也就是提示词里那行「规范正文路径」指向的文件。仓库源码那份不监视：改了源码仍需重新安装才真正生效，
> 监视它只会让你误以为已经生效。

> **§十五 是 Agent 自己追加全局规则的地方，而重装插件会用仓库里的正文覆盖它。**
> 升级前先把 §十五 的内容备份出来，装完再贴回去。

### 改提示词结构 / 工具面 / 行配置

改 `index.js` 的 `buildDefinition()`。它是一个纯函数，`verify.mjs` 直接 import 它来断言，
所以改完立刻能自检。

**注意**：预设 id `wip-codegen` 会被会话记录粘住，改名会让旧会话打不开。除非有充分理由，不要动它。

---

## 本地自检

### 离线（不依赖 DSH，任何机器都能跑）

```powershell
node verify.mjs            # 定义 + 正文 + 必需配置 + 打包清单
node verify-lifecycle.mjs  # 注册/卸载生命周期、竞态、失败路径
node check-patch.mjs       # cordis.patch.yml 的 insert 结构
node check-encoding.mjs    # 全仓库无 BOM、JSON 可解析、脚本语法通过
```

都是**可移植的**：只读本包内相对路径，不依赖任何机器专属路径。

- `verify.mjs` 拿 `buildDefinition()` 的实际输出与磁盘上的正文**逐字比对**，确认没有 fallback
  正文混进来、正文没被截断；并断言两个**必填配置**在场；还直接驱动索引引擎
  （`parseJavaSource` / `parseXmlMapper` / `queryIndex` / `readIndexEntry`）断言解析与检索结果，
  所以引擎改坏了离线就能发现，不必真装一次；
- `verify-lifecycle.mjs` 用假 context 驱动 `apply()`，**证明卸载真的会 dispose**；
- `check-patch.mjs` 优先借用 DSH 安装里的真实 js-yaml，找不到时退化到内置最小解析器。

### 运行时（真装一次，端到端）

```powershell
node verify-runtime/run.mjs                 # 用本地目录装进一个隔离 profile
node verify-runtime/run.mjs --from-github   # 改成从 GitHub 装（发布后必跑）
node verify-runtime/run.mjs --dsh "C:\path\to\dsh.cmd"   # 启动器不在默认位置时
```

> 启动器默认取 `G:/tool/deepseekharness/resources/runtime/cli/bin/dsh.cmd`（Windows）或 PATH 上的 `dsh`。
> 装在别处就加 `--dsh`，否则会在第一行报 `launcher not found`。

它会：

1. 在一个**独立 `DSH_HOME`**（`<本包>/.verify-runtime/home`）里建一个干净 profile——
   不碰你的 profile、会话、凭证与正在运行的 DSH；
2. 装本插件 + 测试插件（**先 remove 再 add**，理由见下）；
3. 用 `--patch` 挂一个只读探针，启动后读取**真实装配结果**：预设是否 `broken`、每行插件的
   `fiberState`、预设作用域内的技能目录、`api-test` 正文是否带新规则、
   persona 行是不是自带的 `persona-hot`（且静态 persona 行没有并挂）、
   **live 段落的字符数是否等于磁盘文件**（不等就说明正文被钉在了挂载那一刻）；
   并在预设作用域里**真跑一次提示词组装与渲染**
   （`systemPrompt.assemble()` + `renderPrompt()`），把组装异常原样报回来；
4. 断言完把临时 `DSH_HOME` 删掉（`--keep` 可保留排查）。

**不调用模型、不需要账号**：探针读完就 `process.exit(0)`——它只是把模型请求之前的那一步跑掉。

### 为什么需要一个运行时自检

因为下面三个真实的坑，离线自检（以及"装上了、能选中预设"）都发现不了：

1. **必填配置**：行配置缺必填字段 → 整条预设 `broken`，Agent 选都选不了（v1.x 的真实状态）；
2. **pnpm 复用**：`file:` 依赖的 spec 没变时，`add` 会直接复用 store 里的旧副本——
   于是"明明改了代码，测出来的还是旧行为"。runner 因此改成**先 remove 再 add**，
   并额外比对装入副本与工作树的哈希，证明测的是同一份代码；
3. **未注册的提示词变量**：预设能装上、能被选中、行也全部 `ACTIVE`，但正文里写了
   `{{cwd}}` 这类平台不注册的名字，于是**每一次**模型请求都在提示词组装阶段抛
   `unknown prompt variable … in section "deployment:persona-prefix"`（UI 上就是「本轮运行失败」）。
   v2.0.0 正是栽在这里。探针现在会读 `probe.assembly`：在预设作用域里真跑一次
   `systemPrompt.assemble()` + `renderPrompt()`，只要组装抛错就报 `assemblyError`。

> 第 3 条的教训：**"预设不 broken"不等于"能用"**。前者只覆盖激活审计，后者才覆盖提示词渲染——
> 这是两条独立的失败路径，运行时要分别验。

---

## 发布新版本

GitHub 装的 bundle **不会自动跟进新提交**：pnpm 认为 lockfile 已满足，即使远端有新 commit
也一直用旧版本。升级必须走三步：

```
action: remove_bundle, target: dsh-wip-codegen-agent
action: install_bundle, target: github:yuanli-6/dsh-wip-codegen-agent
action: set_plugin, target: include:dsh-wip-codegen-agent, enabled: false
action: set_plugin, target: include:dsh-wip-codegen-agent, enabled: true
```

（若尚未安装，`remove_bundle` 会报 not-removable，直接 install 即可。测试插件同理。）

**发布前**：改 `package.json` 版本号 → 跑一遍四个离线自检 → 提交推送。
**推送后**：跑 `node verify-runtime/run.mjs --from-github` 实测一次干净安装。
别只核对 git 状态就宣称完成——这个仓库的姐妹项目就曾因为 BOM 让云端版本装不上，而本地一切正常。

---

## 目录结构

```
dsh-wip-codegen-agent/
├── package.json                        # 声明 dsh.bundle.patch
├── cordis.patch.yml                    # insert 一行插件条目（热插拔的开关）
├── index.js                            # 预设定义：buildDefinition() + apply()
├── persona-hot.js                      # persona 行：正文每步重读文件，改完即生效
├── project-index.js                    # 索引引擎 + 30 分钟监听器 + project_index 工具
├── assets/
│   └── wip-codegen/
│       └── system-prompt.md            # 规范正文（唯一可编辑的内容源，含 §十五 全局规则）
├── verify.mjs                          # 定义 / 正文 / 必需配置 / 打包自检
├── verify-lifecycle.mjs                # 注册与卸载生命周期自检
├── verify-runtime/
│   ├── probe.js                        # 只读探针：读装配结果与技能目录后退出
│   └── run.mjs                         # 隔离 profile 里真装一次并断言
├── check-patch.mjs                     # patch 结构校验
├── check-encoding.mjs                  # 编码与语法不变式
└── LICENSE
```

---

## 原理

平台里「一个 Agent」= 一个 **preset**：它把一组插件组合起来，这些插件拥有模型可见的提示词与工具。
所以本 bundle 只做一件事——调 `agentPresets.register()` 声明一个预设，行的都是平台已公开的包
（外加一个可选配套包）。

定义**以 JS 对象**直接交给 `register()`，不经 YAML 文本序列化：长正文不会被折叠标量之类的
序列化形式改写。这点比走「设置 → Agent 中心」那条路（定义要落成 YAML）更保险——
那条路我们实测过，得额外做两道"逐字一致"比对才敢确认无损。

正文从 `assets/` 读盘；万一读不到，退化成一段**自诊断提示词**而不是让注册失败——
预设存在且能自述损坏，比预设凭空消失好定位得多。

persona 那一行挂的是本包自己的 `persona-hot.js`，不是平台自带的 `@deepseek-ai/dsh-persona`。
差别只有一个，但很关键：后者的正文是**配置字符串**，而预设配置在挂载时会被 `structuredClone`，
于是正文被钉死在激活那一刻；前者的正文是**函数**，提示词注册表每次组装都重新调用，
所以文件一改、下一步就是新正文（详见「改规范正文」）。

`project-index.js` 那一行同理是**本包自己的模块**，不是平台包：它要做的事平台没有现成的包提供
（确定性源码解析 + 租约式后台重建 + 一个 `project_index` 工具）。

它的 `inject` 是 `['tools']`，`workingDirectory` 才是可选的（用 `ctx.get(name, false)` 惰性取，
取不到就退化成 `process.cwd()` 找项目根）。这个分工是踩出来的，两处都别再改回去：

- **`tools` 必须写成硬依赖。** 写成 `ctx.get('tools', false)` 惰性取时，激活那一刻服务常常还没上
  context，查出来是空的；而唯一的重试挂在 `agent/pre-step` 上——于是「挂载了预设但没跑过任何
  step」的场合（正是 `verify-runtime` 的 probe 干的事）会出现组合完美、每行都 ACTIVE、模型却
  拿不到工具。`verify-runtime` 的「`project_index` 工具确实到得了模型」这条断言就是为此加的。
- **`inject` 只能用数组形式。** 写成 `{ required: [...], optional: [...] }` 时 cordis 把键名当
  服务名，于是等两个叫 `required` / `optional` 的服务，整行卡在 `PENDING`，报
  `waiting for required, optional`。这个坑也踩过一次。

## License

MIT
