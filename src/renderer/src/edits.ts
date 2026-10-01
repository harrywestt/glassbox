import type { ToolCall } from './session'

/** Before/after text for an edit tool call. */
export function editText(call: ToolCall): { before: string; after: string } {
  const i = call.input
  if (call.name === 'Write') return { before: '', after: String(i.content ?? '') }
  if (call.name === 'MultiEdit' && Array.isArray(i.edits)) {
    const edits = i.edits as { old_string: string; new_string: string }[]
    return { before: edits.map((e) => e.old_string).join('\n'), after: edits.map((e) => e.new_string).join('\n') }
  }
  return { before: String(i.old_string ?? ''), after: String(i.new_string ?? '') }
}
