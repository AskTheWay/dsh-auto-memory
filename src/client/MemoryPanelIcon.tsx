/**
 * 侧栏"记忆"入口图标;按钮、标签与选中态由侧栏自身渲染。
 * 0.9.1:换用内联 SVG"大脑 + 神经连接点"造型(记忆的通用意象),
 * 描边用 currentColor 自动跟随侧栏选中态配色。
 */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export function MemoryPanelIcon(_props: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', margin: 'auto' }}
    >
      {/* 大脑轮廓(左右两半球) */}
      <path d="M9.5 3a3 3 0 0 0-3 3 3 3 0 0 0-2.4 4.6A3.2 3.2 0 0 0 4.5 16a3 3 0 0 0 3 4.5c.9.6 2 .5 2-.5V4.5c0-1-.9-1.5-2-1.5Z" />
      <path d="M14.5 3a3 3 0 0 1 3 3 3 3 0 0 1 2.4 4.6 3.2 3.2 0 0 1-.4 5.4 3 3 0 0 1-3 4.5c-.9.6-2 .5-2-.5V4.5c0-1 .9-1.5 2-1.5Z" />
      {/* 神经连接点(记忆节点的意象) */}
      <circle cx="8" cy="9" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="10" cy="13.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="16" cy="9" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="14" cy="13.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
