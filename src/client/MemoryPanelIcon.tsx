/**
 * 侧栏"记忆"入口图标;按钮、标签与选中态由侧栏自身渲染。
 */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** 按侧栏请求的边长渲染图标(使用基线 ui-primitives 的通用图标)。 */
export function MemoryPanelIcon(_props: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <span aria-hidden style={{ fontSize: '15px', lineHeight: 1 }}>🗂</span>
}
