# 复盘:向 awesome-dsh-plugin 提交收录 PR #5696 的排错记录

- **日期**:2026-09-22
- **目标**:把 dsh-auto-memory 提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)(16.5k★ 精选列表)收录
- **结果**:PR [#5696](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5696) 最终以规范形态就绪(单数据文件投稿);过程中触发 5 个错误,跨流程、协议、OS、语言四层
- **格式**:仿 dsh 官方 `.agents/notes/postmortem` 惯例

## 时间线与错误详解

### E1. 投稿方式错误:手编了生成产物(根本性错误)

- **现象**:PR 创建后 CI `check` 失败;`Submission gate` 提示 "This PR adds no file under `data/plugins/`"
- **做了什么**:参照列表 README 的表面格式(条目按 owner 排序、双语两份),直接在 `README.md` / `README.zh.md` 的 Memory 段各插入一行
- **根因**:该列表的 README 是脚本从 `data/plugins/*.yml` 生成的产物,贡献指南第一句即 "The READMEs are generated — don't edit them by hand"——**动手前没有读贡献指南**。README 中的 `<!-- BEGIN TOC -->` 生成标记是被忽略的线索
- **修复**:还原两个 README;改为添加单个 `data/plugins/AskTheWay__dsh-auto-memory.yml`(四字段:url/name/category/description.en+zh)
- **教训**:**给遵循 SSOT(单一事实源)的系统投稿,改它的真相源,不要改它的渲染产物**。动手前必读贡献指南;文档中被注释包裹的结构通常是机器生成/消费的

### E2. 还原 README 时 base64 静默截断(最隐蔽)

- **现象**:还原后 CI 报 `README.md: missing marker pair <!-- BEGIN TOC --> … <!-- END TOC -->`
- **做了什么**:用 GitHub contents API 取回原文并 PUT 还原
- **根因**:GitHub API 的 `content` 字段是**每 60 字符插入换行的 base64**(RFC 2045 风格);Node 的 `Buffer.from(str, 'base64')` 遇到换行等非法字符会**静默停止解码**——不报错、不警告。1.2MB 文件只解出第一行(约 45 字节),还原成了截断版
- **加剧因素**:几小时前处理同一仓库时曾正确使用 `.replace(/\n/g, '')` 再解码,写新脚本时丢失了这一步——同样的知识在两小时间隔的代码里丢了一次
- **修复**:解码前剥离所有空白(`replace(/\s/g, '')`)
- **教训**:静默截断类缺陷只能靠**产出长度/哈希校验**捕获;解码外部数据的代码必须断言 `Buffer.byteLength(result) === 声明长度`

### E3. ENOBUFS:1.66MB JSON 超出进程管道缓冲

- **现象**:还原脚本 crash,`spawnSync C:\WINDOWS\system32\cmd.exe ENOBUFS`,子进程被 SIGTERM
- **做了什么**:`execSync('gh api .../git/blobs/<sha>')` 把 blob JSON 从子进程 stdout 读回 node
- **根因**:Windows 上 `child_process.execSync` 的 stdout 缓冲上限约 1MB;blob 响应(1.2MB 原文的 base64 ≈ 1.66MB JSON)超限
- **修复**:大数据不走管道——shell 重定向 `gh api ... > file.json` 让 gh 直接写盘,node 读文件
- **教训**:子进程传大数据,**文件 > 管道**;`execSync` 的隐式缓冲在 Windows 上尤其紧

### E4. UTF-16 码元数 ≠ 字节数(校验误报)

- **现象**:解码正确的数据被自检拒绝:`decode mismatch 1244351 vs 1246551`,恒差 2200
- **做了什么**:校验写成 `original.length !== blob.size`
- **根因**:JS `string.length` 数的是 **UTF-16 码元**,GitHub `blob.size` 是 **UTF-8 字节数**;README 含约 1100 个中文字符(1 码元 = 3 字节),差额恰为 2200
- **修复**:校验改用 `Buffer.byteLength(original, 'utf8')`
- **教训**:JS 处理多语言文本时 `length` 几乎永远是错的度量;所有"长度限制/校验"代码先问一句:码元还是字节

### E5. 仓库年龄闸门(非错误,是等待)

- **现象**:`Submission gate` 失败,"repository is 0.1 days old (needs 1)"
- **性质**:列表的反垃圾门槛(防建库即刷榜),日志明示 "nothing to do: this check re-runs by itself and should clear in about 23h"
- **教训**:排错前先区分**失败**与**等待**——日志明说无需动作的红,不构成行动信号

### 插曲:会话权限拦截

首次 `gh pr create` 被本地会话的权限策略拦截(命令未发出,GitHub 上从未存在"失败的 PR")。用户明确授权后以 `--body-file` 形式成功。提醒:**外向动作(发布、提 PR)被工具拦下时,先取得用户明确授权再重试,而不是绕行**。

## 根因分层

| 层 | 错误 | 关键词 |
|---|---|---|
| 流程层 | E1 | 未读贡献指南;改生成物而非数据源 |
| 协议层 | E2 | API 返回换行 base64;解码器静默停止 |
| OS 层 | E3 | Windows 管道缓冲 ~1MB |
| 语言层 | E4 | `length` 的 UTF-16 语义 |
| 无(等待) | E5 | 时间闸门自动重跑 |

## 可复用规则(沉淀)

1. 给外部项目投稿:**先读贡献指南,再动第一个文件**
2. 解码外部数据:`strip 空白 → 解码 → 断言字节数`
3. 子进程大数据:重定向落盘,不走 stdout 管道
4. JS 字符串长度校验:一律 `Buffer.byteLength`
5. CI 红了先读日志全文,区分"失败"与"等待"
6. SSOT 系统:只改真相源,渲染产物交给生成器

## 与本项目设计的呼应

dsh-auto-memory 自身采用同一设计:**MEMORY.md 是派生物**(真相源是记忆文件集,每次写入/删除在文件锁内全量重建),手改 MEMORY.md 会在下一次重建时被覆盖——与 awesome 列表"yml 是真相源、README 是渲染产物"完全同构。单一事实源 + 生成视图,是这份复盘与插件设计共同的主题。
