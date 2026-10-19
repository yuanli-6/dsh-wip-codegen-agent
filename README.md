# dsh-wip-codegen-agent

一个 **DSH Agent bundle**：把「WIP（在制品）/ HRP（人事）代码生成规范」注册成一个可选的 Agent 预设。

装上去，**新开对话选「WIP/HRP 代码生成」**即可用；卸掉，它干干净净消失。

- 不注册任何 Tool，没有 Client 半边，**零依赖**；
- 提示词正文是仓库里一份普通 Markdown（`assets/wip-codegen/system-prompt.md`），改它就行；
- 装/卸靠一行插件行，**真热插拔**（见下方「为什么说热插拔」）。

## 这个 Agent 能做什么

| 能力 | 说明 |
|---|---|
| **SQL Server 建表脚本生成** | 给字段清单 / 界面截图 / Excel 样例 / 自然语言描述，产出可直接执行的建表脚本：存在则删除 → CREATE TABLE（行内注释）→ 每字段 `sp_addextendedproperty` → 表注释 → 索引建议 → 末尾注释掉的删表语句；表名/主键/字段/类型/审计字段/索引全部按规范。可选在指定目录生成 `.sql` 文件（`wip-20261011-任务安排表-未测试-未发生产.sql`） |
| **Java 代码生成** | Spring Boot 3 + MyBatis-Plus：实体、Req/Resp、Import/Export、Mapper + XML、Service + ServiceImpl、Controller |
| **先确认再落地（红线）** | SQL 出草案后必须**逐个字段**与用户确认（补充/删除/修改）才写文件；代码生成前先问「一次性全部 / 逐个类确认」，逐个模式每生成一个类就停下确认；**任何删除（文件/类/字段/方法/表）必须先确认**才执行 |
| **复制现有 Controller 风格** | 先把一个已存在的 Controller 定为「风格基准类」，**真实读源码**抽出包/注解/注入/命名/返回包装/日志/注释风格，之后每个类都按它复制；与规范冲突时以基准类为准并说明 |
| **全局规则沉淀** | 用户说「以后都这样 / 全局都要 / 加到规范里」→ Agent 把规则追加进正文 §十五「全局规则（用户追加）」，本次会话立即生效，下次会话需重载插件 |
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

锁定版本：`github:yuanli-6/dsh-wip-codegen-agent#v2.0.1`。
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

**系统提示词**：`@deepseek-ai/dsh-persona` 的 `prefix` 承载规范全文，并且 `complete: true`。

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
| `@deepseek-ai/dsh-persona` | 承载规范正文（`complete: true`） |
| `@deepseek-ai/dsh-tool-skill` | 渲染技能目录 + 提供 `skill` 加载工具；**没有它，内置的 api-test 技能永远加载不了** |
| `dsh-api-test-bundle` | 接口测试技能本体（可选，装不到就自动不挂） |
| `tool-fs` / `tool-fs-search` | 读 SQL/样例/基准类、写生成出的代码 |
| `pwsh`（Windows）/ `bash`（其他） | 跑构建、看目录 |
| `tool-ask-user` | **§十四 的确认流程全靠它**（没有它就无法"先确认再落地"） |
| `tool-todo` | §十 的输出顺序 + 逐类确认的进度 |

**刻意不给**，都有理由：

- `subagent` / `workflow` / `ralph` —— 这个 Agent 是写代码的，不派活；
- `memory_*` —— 规范与记忆无关；
- `plugin_manager` —— 不许它改插件；
- `plan-mode` —— 规范自己就是一套完整流程。

> v1.x 曾经刻意不给 `skill`（省 token）。v2.0.0 改了：既然是"把这个插件配置到这个 agent 里"，
> 就必须有目录与加载工具，否则技能注册了也没人看得见。代价是一条技能描述（上限 400 字符）。

> **v2.0.1 修的是 v2.0.0 的致命 bug**：正文末尾曾注入 `工作目录：{{cwd}}`，
> 而平台的提示词循环只注册 `provider` / `model` 两个变量，于是每次模型请求都在
> `deployment:persona-prefix` 段组装失败（`unknown prompt variable "{{cwd}}"`）。
> 修法不是换变量名，而是**删掉那一行**：工作目录本来就由工作目录服务以必需运行时上下文
> （`Current working directory: …`）下发，`complete: true` 压不掉它，重述一遍既多余又致命。
> 用 v2.0.0 的请按「发布新版本」的三步升级。

### 两个必需的配置字段（别删）

`tool-fs-search` 的 `sampleOverCapGlobResults` 与 `tool-todo` 的 `allowParallelInProgress`
在本版 DSH 里是**必填且无默认值**。少一个，激活审计就会否掉整条预设：

> 现象是预设变成 `broken`、**选都选不了**，而报错只出现在预设的 `broken` 字段里。

v1.x 正是漏了这两个字段，所以那个版本**从来没有真正可用过**（离线自检全绿，因为离线看不到配置契约）。
现在 `index.js` 里两行都带上（值取自平台自带的 `standard` 预设），`verify.mjs` 也会断言它们，
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

改 `assets/wip-codegen/system-prompt.md`，然后让插件重新加载：

```
action: set_plugin, target: include:dsh-wip-codegen-agent, enabled: false
action: set_plugin, target: include:dsh-wip-codegen-agent, enabled: true
```

正文是在**插件激活那一刻**读进内存的（`register()` 要求定义当场给全，没有惰性加载回调），
所以**只改文件不会自动生效**——不 toggle 就重启 DSH。

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
  正文混进来、正文没被截断；并断言两个**必填配置**在场；
- `verify-lifecycle.mjs` 用假 context 驱动 `apply()`，**证明卸载真的会 dispose**；
- `check-patch.mjs` 优先借用 DSH 安装里的真实 js-yaml，找不到时退化到内置最小解析器。

### 运行时（真装一次，端到端）

```powershell
node verify-runtime/run.mjs                 # 用本地目录装进一个隔离 profile
node verify-runtime/run.mjs --from-github   # 改成从 GitHub 装（发布后必跑）
```

它会：

1. 在一个**独立 `DSH_HOME`**（`<本包>/.verify-runtime/home`）里建一个干净 profile——
   不碰你的 profile、会话、凭证与正在运行的 DSH；
2. 装本插件 + 测试插件（**先 remove 再 add**，理由见下）；
3. 用 `--patch` 挂一个只读探针，启动后读取**真实装配结果**：预设是否 `broken`、每行插件的
   `fiberState`、预设作用域内的技能目录、`api-test` 正文是否带新规则、
   persona 会不会拿到正文与注入路径；并在预设作用域里**真跑一次提示词组装与渲染**
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
├── index.js                            # 唯一逻辑：buildDefinition() + apply()
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

## License

MIT
