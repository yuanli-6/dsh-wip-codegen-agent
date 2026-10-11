# dsh-wip-codegen-agent

一个 **DSH Agent bundle**：把「在制品管理（wip）/ 人事管理（hrp）Java 代码生成规范」注册成一个可选的 Agent 预设。

装上去，**新开对话选「WIP/HRP 代码生成」**即可用；卸掉，它干干净净消失。

- 不注册任何 Tool，没有 Client 半边，**零依赖**；
- 提示词正文是仓库里一份普通 Markdown（`assets/wip-codegen/system-prompt.md`），改它就行；
- 装/卸靠一行插件行，**真热插拔**（见下方「为什么说热插拔」）。

---

## 安装

在 DSH 里让 agent 调用 `plugin_manager`：

```
action: install_bundle
target: github:yuanli-6/dsh-wip-codegen-agent
```

锁定版本：`github:yuanli-6/dsh-wip-codegen-agent#v1.0.0`

本地改代码时用目录安装（以 `link:` 接入，改动即刻对插件可见）：

```
action: install_bundle
target: <本目录绝对路径>
```

装完**新开一个对话**，在预设选择里就能看到 **WIP/HRP 代码生成**。

> 插件属于**本机 profile**（`$DSH_HOME/profiles/<profile>/`），不属于 DSH 账号。
> 换机器需要重新执行一次上面的安装——这正是走 GitHub 的意义。

### 装之前要先做一件事（重要）

如果你之前在 **设置 → Agent 中心** 里手工建过同名预设，**先把它删掉**。

同一个 preset id 全局只能注册一次。两边都注册 `wip-codegen` 时，后到的那个会失败并报
`Duplicate agent preset`。这个报错只在日志里、不影响别的插件，所以现象是"装了但没反应"。

---

## 用它

1. 新建对话；
2. 预设选 **WIP/HRP 代码生成**；
3. 把**建表 SQL** / **UI 截图** / **Excel 样例** / **SAP 字段映射**任意一样丢进去。

它会按规范产出 Spring Boot 3 + MyBatis-Plus 的实体、Req/Resp、Import/Export、Mapper + XML、Service + ServiceImpl、Controller。

### 它被配成什么样

**系统提示词**：`@deepseek-ai/dsh-persona` 的 `prefix` 承载规范全文，并且 `complete: true`。

`complete: true` 是平台第一方表达「这段就是完整系统提示词」的方式。含义是：
**只有这份规范进上下文**，记忆导引、team 政策、plan 政策、其他插件的工具指引都不会再注入。
规范本身是强制性的（"必须严格遵守"），稀释它没有好处。变量与工具 schema 照常解析，
所以规范末尾那行 `工作目录（当前项目根）：{{cwd}}` 能正确渲染，工具也照常可调用。

**工具面**（除了机制工具，清单外的一律收起）：

| 工具 | 为什么给 |
|---|---|
| `read` `write` `edit` `glob` `grep` | 读 SQL/样例、写生成出的代码 |
| `pwsh`（Windows）/ `bash`（其他） | 跑构建、看目录 |
| `ask_user_question` | 规范要求"先确认字段清单与字典含义" |
| `todo_write` | 规范第十节是一套 9 步输出顺序 |

**刻意不给**，都有理由：

- `skill` —— 不给它，整条技能目录都不注入。代码生成用不上技能，省下的 token 是纯赚；
- `subagent` / `workflow` / `ralph` —— 这个 Agent 是写代码的，不派活；
- `memory_*` —— 规范与记忆无关；
- `plugin_manager` —— 不许它改插件；
- `plan-mode` —— 规范自己就是一套完整流程。

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

### 改规范正文

改 `assets/wip-codegen/system-prompt.md`，然后让插件重新加载：

```
action: set_plugin, target: include:dsh-wip-codegen-agent, enabled: false
action: set_plugin, target: include:dsh-wip-codegen-agent, enabled: true
```

正文是在**插件激活那一刻**读进内存的（`register()` 要求定义当场给全，没有惰性加载回调），
所以**只改文件不会自动生效**——不 toggle 就重启 DSH。

> 注意：`cordis.patch.yml` 本身改了必须重启（要重建 loader 树）；只改正文/SKILL 之外的代码用 toggle 即可。

### 改提示词结构 / 工具面

改 `index.js` 的 `buildDefinition()`。它是一个纯函数，`verify.mjs` 直接 import 它来断言，
所以改完立刻能自检。

**注意**：预设 id `wip-codegen` 会被会话记录粘住，改名会让旧会话打不开。除非有充分理由，不要动它。

---

## 本地自检（不依赖 DSH）

```powershell
node verify.mjs            # 定义 + 正文 + 打包清单（32 项）
node verify-lifecycle.mjs  # 注册/卸载生命周期、竞态、失败路径（10 项）
node check-patch.mjs       # cordis.patch.yml 的 insert 结构（13 项）
node check-encoding.mjs    # 全仓库无 BOM、JSON 可解析、脚本语法通过
```

四个脚本都是**可移植的**：只读本包内相对路径，不依赖任何机器专属路径。

- `verify.mjs` 会拿 `buildDefinition()` 的实际输出与磁盘上的正文**逐字比对**，
  确认没有 fallback 正文混进来、正文没被截断；
- `verify-lifecycle.mjs` 用假 context 驱动 `apply()`，**证明卸载真的会 dispose**；
- `check-patch.mjs` 优先借用 DSH 安装里的真实 js-yaml，找不到时退化到内置最小解析器
  （覆盖本 patch 用到的 YAML 子集），并打印实际使用的解析器。

`check-encoding.mjs` 存在的理由：`package.json` 一旦带上 UTF-8 BOM，
**从 GitHub 安装会直接失败**（pnpm 报 `Unexpected token '\uFEFF'`）。
用 PowerShell 的 `Set-Content -Encoding utf8` 改文件会写入 BOM，所以改完跑一次它；`--fix` 可自动移除。

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

（若尚未安装，`remove_bundle` 会报 not-removable，直接 install 即可。）

**发布前**：改 `package.json` 的版本号 → 跑一遍四个自检脚本 → 提交推送。
**推送后**：**必须从 GitHub 干净装一次实测**。别只核对 git 状态就宣称完成——
这个仓库的姐妹项目就曾因为 BOM 让云端版本装不上，而本地一切正常。

---

## 目录结构

```
dsh-wip-codegen-agent/
├── package.json              # 声明 dsh.bundle.patch
├── cordis.patch.yml          # insert 一行插件条目（热插拔的开关）
├── index.js                  # 唯一逻辑：buildDefinition() + apply()
├── assets/
│   └── wip-codegen/
│       └── system-prompt.md  # 规范正文（唯一可编辑的内容源，7583 字符）
├── verify.mjs                # 定义 / 正文 / 打包自检
├── verify-lifecycle.mjs      # 注册与卸载生命周期自检
├── check-patch.mjs           # patch 结构校验
├── check-encoding.mjs        # 编码与语法不变式
└── LICENSE
```

---

## 原理

平台里「一个 Agent」= 一个 **preset**：它把一组插件组合起来，这些插件拥有模型可见的提示词与工具。
所以本 bundle 只做一件事——调 `agentPresets.register()` 声明一个预设，行的都是平台已公开的包。

定义**以 JS 对象**直接交给 `register()`，不经 YAML 文本序列化：长正文不会被折叠标量之类的
序列化形式改写。这点比走「设置 → Agent 中心」那条路（定义要落成 YAML）更保险——
那条路我们实测过，得额外做两道"逐字一致"比对才敢确认无损。

正文从 `assets/` 读盘；万一读不到，退化成一段**自诊断提示词**而不是让注册失败——
预设存在且能自述损坏，比预设凭空消失好定位得多。

## License

MIT
