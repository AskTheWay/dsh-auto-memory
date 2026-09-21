/**
 * dsh-auto-memory 核心类型定义。
 * 对齐 Claude Code auto-memory 的记忆模型:单文件 + frontmatter + 四种类型。
 * (插件配置 Config 定义在 index.ts,官方惯例。)
 */

/** 记忆类型(对齐 Claude Code 的四种语义)。 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

/** 作用域:项目级(workspace 隔离)或用户级(所有会话共享)。 */
export type MemoryScope = 'project' | 'user'

/** 一条持久记忆。与磁盘上单个 .md 文件一一对应。 */
export interface MemoryRecord {
  /** kebab-case 标识,同时是文件名(不含扩展名)。 */
  name: string
  /** 人类可读标题(可含中文,进索引行链接文本);缺省用 name。 */
  title?: string
  /** 一行摘要:注入索引展示、召回相关性判断、查重依据。 */
  description: string
  /** 四种类型之一。 */
  type: MemoryType
  /** 正文事实。feedback 类型约定包含 **Why:** 与 **How to apply:** 行。 */
  body: string
  /** 来源作用域(决定存储目录)。 */
  scope: MemoryScope
}

/** 用户级作用域的目录名(下划线前缀避免与项目 slug `--...--` 冲突)。 */
export const USER_SCOPE_DIR = '_user'
