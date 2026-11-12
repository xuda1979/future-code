export interface ParsedLoopTask {
  /** Durable authority must retain the complete user input, including cadence,
   * stop conditions and any other constraints; never bind only the display task. */
  goalText: string
  task: string
  stopCondition: string | null
  interval: string | null
}

function stopMarker(text: string): number {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '\\') { i++; continue }
    if (quote) { if (char === quote) quote = null; continue }
    if ((char === '"' || char === "'" || char === '`') &&
        (i === 0 || /[\s([{:=>]/.test(text[i - 1]!))) { quote = char; continue }
    if ((i === 0 || /\s/.test(text[i - 1]!)) && /^stop:/i.test(text.slice(i))) return i
  }
  return -1
}

/** Pure parsing only. Command/Skill prompt getters share execution context,
 * so only a trusted host user-command boundary may bind the returned goalText. */
export function parseLoopTask(args: string): ParsedLoopTask | null {
  const goalText = args.trim()
  if (!goalText) return null
  const marker = stopMarker(goalText)
  const stopCondition = marker < 0 ? null : goalText.slice(marker + 5).trim()
  let task = marker < 0 ? goalText : goalText.slice(0, marker).trim()
  if (stopCondition === '') return null
  let interval: string | null = null
  const leading = /^(\d+)([smhd])(?:\s+|$)/i.exec(task)
  const trailing = leading ? null : /\s+every\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])$/i.exec(task)
  const cadence = leading ?? trailing
  if (cadence) {
    const amount = Number(cadence[1])
    if (!Number.isSafeInteger(amount) || amount <= 0) return null
    interval = String(amount) + cadence[2]![0]!.toLowerCase()
    task = leading ? task.slice(leading[0].length).trim() : task.slice(0, trailing!.index).trim()
  }
  if (!task) return null
  return { goalText, task, stopCondition, interval }
}
