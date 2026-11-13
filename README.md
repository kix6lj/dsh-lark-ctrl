# dsh-lark-ctrl

飞书（Lark）与 DeepSeek Harness 的桥接插件：在手机上接收会话摘要、回答 Agent 的提问、处理审批，并用 `#code` 继续驱动会话。

Host-only bundle，运行在 DSH Host 进程内；通过 `lark-cli` 的长连接收发飞书事件，**不需要公网回调地址**。

## 功能

- **会话开始摘要**：每个 run 开始时推送一张卡，含稳定的会话码 `#a1b2c3`、标题、触发本轮的用户输入、cwd、模型。
- **真正 idle 时发结束摘要**：等 Agent 没有活动 turn、没有排队消息，并经过短暂宽限期后，推送完成卡（耗时、工具调用数、tokens、最后回复、失败原因）。goal 连续轮次会被合并，避免刷屏。
- **提问卡片**：`ask_user_question` 的选项、多选、自定义文本、多问题批量、plan review 都会渲染成飞书卡片；单选问题是一键按钮，多选/多问题用表单提交。回答以标准 `AskUserQuestionAnswer` 回流，和 Web Client 完全一致。
- **审批卡片**：`approval/request` 渲染「允许一次 / 拒绝」，在卡片里用代码框显示具体工具参数/命令；处理后原卡保留工具、原因、命令、决定和处理来源，便于留下痕迹。返回 `allowed-once` / `rejected`。
- **与 Web 共存**：默认 `race` 模式，飞书和 Web 谁先答谁生效；另一边卡片会被更新为「已回答」。
- **手机发 prompt**：`#code 继续实现 X`、直接回复任意会话通知、`/steer`、`/stop`、`/status`、`/sessions`。
- **`/btw` 旁问**：状态快照；已安装 `dsh-btw` 时，自动复用它的 `/api/btw.ask` 做 LLM 旁问（不调用工具、不写入会话）。未安装时只降级为快照，不会报错。
- **推送级别**：`/level` 或 `/level 0|1|2`；L0 静默、L1 只推提问/审批、L2 全部；切回 L1/L2 时会补发 Web 尚未处理的提问/审批。
- **工作区**：`/workspaces [1h|1d]` 按工作区分组；每个会话可打开、每个工作区可新建会话；可新建工作区（绝对路径，自动 `mkdir -p`）。
- **新建会话卡片**：选择 Agent 模式、模型、Thinking effort、权限，并附上首条 prompt。
- **长回答归档**：回答超过卡片摘要长度时，完成卡出现「归档完整回答到飞书文档」按钮；完整回答写入配置的 Wiki 父文档下的子文档，并按日期 / `#code` 在父文档中建立索引。
- **完成卡状态与折叠**：卡头是「状态 · 会话标题」（状态取自本轮证据：完成 / 已回答 / 有工具报错 / 等你回答 / 失败 / 已停止…，并决定卡片配色），会话编号移到脚注；长回答默认折叠在「展开完整回复（N 字）」面板里，卡片正文只留短预览。
- **完成卡快捷按钮**：`[最近会话] [更多命令]` + `[查看状态] [旁问]`，点「最近会话」直接弹出最近会话列表，再点某行「打开」即可切换到那个会话，不用在聊天记录里翻。
- **状态卡看历史**：状态卡只保留一个「历史记录列表」按钮——列表按时间倒序保留最近 32 条、默认展示 16 条、更早的折叠在下面；每行一个「查看」，点开是该条全文，带图片的消息会连同图片一起发回来。
- **图片输入**：在飞书聊天框里发图片即可进会话；也支持一条富文本消息里的「文字 + 图片」；如果飞书把图文拆成两条（先图后文），插件会在 10 秒窗口内自动合并成一条 prompt。文字开头写 `#code` 可以指定落到哪个会话。
- **图片输出**：本轮会话里产生的图片（工具截图、模型产图）会在结束卡之后逐张发到聊天，卡片上提示「📷 本轮 N 张图」。
- **会话列表与详情卡**：最近会话列表和「打开」后的详情卡与完成卡同一套布局——状态色卡头、`#code` 脚注、两行等宽按钮（`[最近会话][更多命令]` / `[查看状态·历史消息][旁问]`）。
- **文字回复降级**：即使飞书卡片回调没开通，也能直接回复提问卡/审批卡完成回答。

## 前置条件

1. 本机有可用的 `lark-cli`，且已登录：
   ```bash
   lark-cli auth status --json
   ```
   插件默认把**当前登录账号**作为推送目标（`identities.user.openId`）。
2. 飞书开发者后台为当前 app 开启：
   - 事件订阅：`im.message.receive_v1`（收手机消息，必需）；
   - 回调配置：`card.action.trigger`（卡片按钮/表单，可选）。
3. 机器人在目标用户的可用范围内；如果发群，把机器人拉进群。
4. DSH `>= 0.2.1-rc.5`（插件通过 `engines.dsh` 声明）。

### 关于卡片回调（重要）

`card.action.trigger` 没开通时：

- 开始/结束/提问/审批卡片仍会正常发送；
- **按钮和表单提交不会回调**；
- 但可以直接**回复**提问卡/审批卡（例如 `1`、`2`、`允许`）完成回答；
- 插件启动时会检测并通过日志 + 一条飞书文字消息提示开通链接；
- 开通后无需重启插件：每 10 分钟自动探测一次。

`card.action.trigger` 在 lark-cli 中是单消费者：**同一时间只能有一个进程消费**。插件运行期间不要再执行 `lark-cli event consume card.action.trigger`。

## 安装

本插件发布在 GitHub，不在 npm；推荐用 DSH 的 **Plugins** 页面安装 Bundle：

- Bundle spec：`github:kix6lj/dsh-lark-ctrl`
- 或完整地址：`git+https://github.com/kix6lj/dsh-lark-ctrl.git`

安装后启用 `dsh-lark-ctrl`（安装时默认已启用），刷新 Harness 页面，然后**重启一次 DSH**。首次启动会给当前登录账号发一条「dsh-lark-ctrl 已上线」的飞书卡片。

CLI 也可以先把包加入当前 profile：

```bash
dsh plugin --profile web add github:kix6lj/dsh-lark-ctrl
```

CLI 只负责把依赖加入 profile；随后在 DSH 的 **Plugins** 页面启用 `dsh-lark-ctrl` bundle，再重启。

> **更新 Host 代码后必须重启 DSH**：卸装/重装 bundle 只会重建插件实例，不会刷新 Host 进程里的 Node ESM 模块缓存。只重装而不重启时，运行中的仍是旧模块。

## 配置

默认值在 `cordis.patch.yml`；在 profile 的 `cordis.patch.yml` 里按行 id `dsh-lark-ctrl` 覆盖：

```yaml
- id: dsh-lark-ctrl
  name: dsh-lark-ctrl
  config:
    larkCli: lark-cli
    identity: bot

    targetUserId: ''        # 空 = lark-cli 当前登录账号
    targetChatId: ''        # 群聊 oc_xxx，优先于 targetUserId
    allowUsers: []          # 空 = 仅 targetUserId

    notifySessionStart: true
    notifySessionEnd: true
    notifyQuestion: true
    notifyApproval: true
    approvalMode: always    # always | no-live-client | off
    includeSubagents: false
    startupMessage: true

    answerMode: race        # race | fallback | exclusive | off
    allowTextReply: true

    summaryMaxChars: 1500
    idleGraceMs: 3000

    btwMode: auto           # auto | snapshot | off
    btwRoute: /api/btw.ask
    btwTimeoutMs: 60000

    # 长回答归档的 Wiki 父文档；空 = 关闭归档按钮（也可用 /archive 卡片或 /archive set 配置）
    # 必须是 docx 类型的 Wiki 节点，例如 https://your-tenant.feishu.cn/wiki/<node_token>
    archiveParentUrl: ''

    defaultTarget: last     # last | require-hash
    maxPromptChars: 8000
    maxInboundPerMinute: 30

    language: zh-CN
    storeDir: ''
    debug: false

    # 卡片上的「工作区行」：把远端工作区的本地镜像路径映射成 <host> <remotePath>
    # 默认读 <DSH_HOME>/workspace-map.json（DSH_HOME 或 ~/.dsh）；这里可改路径或内联
    workspaceMapPath: ''
    workspaceMap: {}
```

### 工作区行

开始卡与结束卡都会渲染一行 `🖥 …`，让手机上能看出这一轮跑在哪台机器的哪个目录：

| `session.header.cwd` | 渲染 |
|---|---|
| `<dshHome>/remote-workspaces/<id>` 且映射命中 | `🖥 10.40.0.7 /develop03/user/proj` |
| 同一镜像路径但映射缺失 | `🖥 <id>`（只退化，不隐藏） |
| 本地目录 | `🖥 C:\work\proj` |

远端工作区会话的 `header.cwd` 是**本地镜像路径**，只有 `<id>`；把它翻成真实服务器与路径的数据来自一份可选 JSON：

```json
{
  "workspaces": {
    "<mirrorId>": { "host": "10.40.0.7", "remotePath": "/develop03/user/proj" }
  }
}
```

读取顺序：`workspaceMap`（内联，优先） → `workspaceMapPath` → `<DSH_HOME>/workspace-map.json`。文件按 mtime 缓存，改完即生效，不需要重启 Host。

### `answerMode`

| 值 | 行为 |
|---|---|
| `race`（默认） | 飞书卡和 Web 卡同时存在，谁先答谁生效 |
| `fallback` | 有 Web Client 在线时只发通知、交给 Web；无在线 Client 时才由飞书接管 |
| `exclusive` | 飞书独占，Web 端看不到提问 |
| `off` | 只通知，不接管 |

### `approvalMode`

| 值 | 行为 |
|---|---|
| `always`（默认） | 所有审批都发飞书卡 |
| `no-live-client` | 只有没有 Web 页面在线时才发 |
| `off` | 不发审批卡 |

## 图片与历史

图片走飞书**聊天框**，卡片里的输入框仍只收文字（飞书卡片没有文件选择器）。

| 操作 | 结果 |
|---|---|
| 聊天框发图 | 图片作为 image block 进入会话（可带一句文字） |
| 一条富文本「文字 + 图片」 | 文字与图片一起注入，用你写的文字当 prompt |
| 先发图、10 秒内补文字 | 自动合并成一条 prompt；超过 10 秒则图片单独注入 |
| 文字开头写 `#code` | 定向到指定会话（`#code` 不会传给模型） |

反向（会话 → 飞书）：一轮里产生的图片会在结束卡之后逐张发到聊天，卡片上标注「📷 本轮 N 张图」；历史记录里带图的行有 📷 标记，点「查看」会把图片一起发回来。
## 使用

| 输入 | 行为 |
|---|---|
| `#k3f9zq 继续实现登录页` | 向该会话 queue 一条 prompt |
| `#k3f9zq /steer 先写测试` | steer 模式发送 |
| `#k3f9zq` | 状态卡 |
| `#k3f9zq /btw 现在在做什么？` | 旁问该会话 |
| `/sessions [1d\|12h\|7d]` | 最近会话（默认最近 10 个）；支持按更新时间筛选，例如 `/sessions 1d` |
| `/workspaces [1h\|1d]` | 按工作区分组；每个工作区可新建会话；底部可新建工作区 |
| `/level` / `/level 0\|1\|2` | 推送级别：0 静默，1 仅提问/审批，2 全部 |
| `/workspace-create /abs/path [\| 标题]` | 可选快捷命令；主入口是 `/workspaces` 卡片 |
| `/status [code]` | 状态卡；省略 code 用最近会话 |
| `/btw [code] [问题]` | 旁问；省略 code 用最近/被回复会话 |
| `/stop [code]` | 取消当前轮次 |
| `/help [命令]` | 命令总览；`/help /sessions` 查看该命令的详细用法、示例、限制和相关命令 |
| `/archive` | 查看长回答归档父文档配置和状态 |
| `/archive delete-before YYYY-MM-DD` | 预览并确认删除该日期之前的归档回答子文档和索引链接 |
| 直接回复任意会话通知 | 内容作为该会话的 prompt |
| 直接回复提问卡/审批卡 | 文字答题（无回调权限时） |

会话码是 `sha256(sessionId)` 的 base32 前 6 位，稳定且可跨重启；冲突时自动延长。

`/sessions` 卡片里每个会话都有「打开」按钮，进入详情卡后可以：

- 直接在表单里输入 prompt 并发送到该会话（不需要 hash）；
- 点「发送 hash」让机器人单独发一条只含 `#code` 的消息，长按复制；
- 查看状态；在表单同一处输入 prompt 后点「旁问」走 `/btw`。

> 飞书 Card 2.0 没有剪贴板/copy 行为（`behaviors: [{type:"copy"}]` 会被飞书拒绝），机器人也无法写入飞书聊天输入框。因此“点一下就自动复制/填入输入框”无法原生实现；上面是可达的最省事路径。

## 开发

Host-only，无构建步骤、无运行时 npm 依赖。

```bash
npm test
```

代码结构：

- `index.js`：Cordis bundle 入口，装配 transport/event bridge/notifier/answerer/router。
- `lib/`：飞书 CLI 封装、事件桥、卡片、路由、存储、注册表、工作区/会话创建与状态配置。
- `test/`：`node:test` 单元测试（不访问真实飞书）。
- `DESIGN.md` / `DESIGN-V2.md`：架构与二期设计记录。

## 工作方式

```text
Agent ask_user_question
  └─ waterfall('user-questions/request')
       ├─ dsh-lark-ctrl（prepend）: 发飞书卡 + next() 给 Web
       └─ 谁先回答谁生效；另一边 patch 成「已回答」
```

- 插件不注册工具、不写 Session 日志、不新增 Remote 端点。
- 结束摘要完全来自 session log，不额外调用模型。
- `/btw` 的 LLM 旁问通过 `ctx.connection.createSharedFetchHandler('/api')` 调用 `dsh-btw` 的 `POST /api/btw.ask`；这是同进程软依赖，插件未安装/路由变化时自动降级。

## 存储

`$DSH_HOME/storages/lark/state.json`：

- 会话码覆盖（碰撞时）；
- `message_id → session` 映射（回复路由）；
- 入站事件去重；
- 最近会话。

只保存映射与去重键，不保存消息正文或凭据。

## 安全

- 只接受 `allowUsers`（默认当前登录账号）的私聊消息与卡片操作；
- 忽略 bot 自己和其他 bot 的消息；
- 群聊只响应 `#code`、`/命令`、或对机器人消息的回复；
- 单条 prompt 限长、入站限速；
- 不执行飞书消息里的任意 shell 命令；prompt 仍走 DSH 正常的权限/审批策略；
- 日志不打印 token/凭据。

## 工作区与新建会话

- `/workspaces 1d` 只显示最近一天有更新的工作区；`/workspaces` 不带过滤时显示空工作区。
- 工作区「新建会话」卡片：
  - 模式：Agent preset（standard/PTC/minimal/cordis）；
  - 模型：来自 `sessionController.modelCatalog()`；
  - Thinking effort：来自所选模型的 `reasoning.efforts`；
  - 权限：来自 `permissionPresets.catalog()`；
  - prompt：首条消息，创建后立即发送（上限 1000 字）。
- `/status` 状态卡显示模式、模型、Thinking effort、权限，并带修改选择框；点「打开会话」进入 prompt 表单（复用会话详情卡）：
  - 权限修改立即生效；
  - 模型/Thinking effort 在下一轮请求生效；
  - 模式在首轮后锁定，只展示不可改。
- 新建工作区：输入绝对路径，目录不存在会 `mkdir -p`；没有权限时创建失败。
- L0 时提问/审批交 Web；切回 L1/L2 时，插件会把仍在等待的提问/审批补发到飞书。

## Web 端可见性

新建工作区和新建会话都直接写 DSH Host 状态，不做“飞书专用副本”：

- **工作区**：`ctx.workspaceRegistry.create(...)` 写入 registry；Web 的 `workspace/follow` 流会收到 `upsert`，侧边栏无需刷新即可出现。
- **会话**：`ctx.sessionController.create({ workspaceId, agentPreset })` 触发 `session/created` → Web 的 `api-session/added`；`workspace.attachSession` 同时更新 workspace 的 `sessionIds`，侧边栏会把它归到对应工作区。插件创建后还会补一个 `api-session/activity`，让已打开的 Web 侧栏立即重排/刷新状态。
- Web 页面当时没打开也没关系：再次打开会从 Host 读取 workspace baseline 和 session 列表，状态是持久的。
- 如果 Web 页面已打开但没看到，先刷新页面；仍看不到时检查 Host 日志中 `workspace-controller` / `api-session/added` 是否有错误。

## 长回答归档

配置归档父文档（docx 类型的 Wiki 节点 URL）有三种方式：

1. 发送 `/archive`，在卡片中粘贴 URL 并点「保存归档文档」；
2. 发送 `/archive set <url>`；
3. 在 profile 的 `dsh-lark-ctrl` 配置里设置 `archiveParentUrl` 作为回退。

配置后，状态卡会显示「归档最近回答到飞书文档」，长回答完成卡也会显示归档按钮。发送 `/archive clear` 可以清除飞书侧配置并回退到 profile 配置。

- 归档时创建父文档下的子文档，完整回答写入子文档；
- 每次归档在父文档链接中记录回答的秒级 UTC 时间戳；再次归档同一时间戳时直接返回已有链接，不重复创建子文档；
- 父文档结构固定为：

  ```text
  # 2026-11-09
  ## #abc123
  [dsh-lark] 2026-11-09T06:30:00Z · 会话标题
  ```

- 每次归档/删除都重新读取父文档最新 XML 和 revision，不在本地保存归档结构；
- 多个 DSH 同时写入时通过 revision 冲突重试收敛；
- 状态卡可直接点「归档最近回答到飞书文档」；如果最近回答已经归档，会返回原链接，不重复插入；
- `/archive delete-before 2026-11-01` 会先扫描并显示确认卡，只删除带 `[dsh-lark]` 标记的索引链接及其子文档，不删除用户手动添加的内容；
- 删除/编辑失败会保留未完成项并在结果卡中列出。

> 归档父文档必须是 docx，且当前登录的飞书用户需要 Wiki/文档读写权限。回答中的图片会转为链接保留，避免文档导入依赖外部图片下载。父文档结构被用户大幅改写时，插件只会按日期标题和 `#code` 标题寻找插入点；找不到时会在末尾追加。
>
> 索引写入使用文档 revision 冲突重试；创建子文档后还会再次检查时间戳，若其他 Host 已写入同一条回答，则删除刚创建的多余子文档并返回已有链接。没有跨 Host 的分布式锁，但同一回答最终只保留一个索引链接。删除后空的日期/`#code` 标题会保留。旧版归档链接没有秒级时间戳，第一次使用新版时可能重新归档一次。

## 已知限制

1. `race` 模式飞书先答时，插件会 abort 转发给 Web 的请求并触发客户端卡片清理，Web 提问面板会随之关闭；极端网络/旧版客户端下仍可能短暂残留，刷新页面即消失。
2. 飞书 Card 2.0 没有 clipboard/copy 行为，机器人也不能写入飞书输入框；会话 hash 通过单独消息或详情卡代码块提供，长按复制。
3. 飞书 Card 2.0 的 Markdown 图片只接受上传后的 `img_key`，普通 `![alt](url)` 会退化为原始 Markdown；因此卡片正文里不内嵌图片——长回答折叠在「展开完整回复」面板里，图片作为独立的图片消息发送。
4. 卡片回调未开通时按钮/表单不可用，只能文字回复（插件会提示）。
5. 插件重启前已经在进行中的**阻塞式**提问，若当时没经过本插件，无法补接管；timed/continued 问题可以补答。
6. 支持文本与图片；文件（非图片）和语音仍未接入——发文件会收到明确提示。
7. 不支持 Web 端会话深链（DSH Web 没有 session URL 路由）。
8. 更新插件 Host 代码后需要重启 DSH；仅重装 bundle 不会刷新 Node 模块缓存。
9. 单用户/单目标为主，不做多租户映射。
10. 依赖 DSH `>= 0.2.1-rc.5` 的 Host 服务/事件契约；升级 DSH 需回归。
11. 卡片状态回写依赖 bot 的 `im:message:update`；没有该 scope 时退化为 callback token/文字确认。

## 排障

| 症状 | 检查 |
|---|---|
| 收不到任何飞书消息 | `lark-cli auth status --json` 是否 user/bot ready；`lark-cli event consume im.message.receive_v1 --dry-run` 是否 ready |
| 收不到卡片回调 | `lark-cli event consume card.action.trigger --dry-run` 是否 blocked；按 hint 开通回调 |
| 卡片按钮点了没反应 | 回调未开通；先文字回复卡片，或开通后等 10 分钟自动探测 |
| 发不出消息 | 机器人是否在目标用户可用范围；先给机器人发一条消息建立会话 |
| `/btw` 只返回状态 | 是否安装了 `dsh-btw`；`dsh-btw` 的 `/api/btw.meta` 是否可用 |
| 结束卡迟迟不来 | 只有真正 idle 才发；检查是否还有排队消息/持续 goal 续跑 |
| 重复消息 | 检查是否有多个 DSH Host 实例或重复安装 |
| 卡片回调仍无反应 | 确认更新 Host 代码后已**重启 DSH**；在 profile 的 `dsh-lark-ctrl` 行加 `debug: true` 后重启，卡片回调原始事件会写到 `/tmp/dsh-lark-ctrl-card-events.ndjson` |

## 卸载

```bash
plugin_manager action=remove_bundle target=dsh-lark-ctrl
```

按需删除 `$DSH_HOME/storages/lark`。


## License

MIT. See [LICENSE](LICENSE).

## Privacy

- 仓库不包含真实飞书 token、app secret、open_id/chat_id 或本机绝对路径；测试中的 `ou_me`、`om_*` 等均为合成值。
- `lark-cli` 的登录凭据由 `lark-cli` 自己保存；dsh-lark-ctrl 不读取、不写入这些凭据。
- 插件运行状态（session code/link、推送级别）保存在 `$DSH_HOME/storages/lark/state.json`，属于本机运行数据，不应提交到仓库。
- 归档结构不保存在本地：只配置父文档 URL，每次操作重新解析飞书文档。
- 推送目标默认是 `lark-cli` 当前登录账号；如需群聊/指定用户，在 profile 配置里填写。
