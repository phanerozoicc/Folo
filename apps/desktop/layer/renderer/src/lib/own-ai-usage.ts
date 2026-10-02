import { getStorageNS } from "@follow/utils/ns"

export type OwnAiFeature = "summary" | "translation" | "sort" | "title" | "task" | "chat"

type UsageRecord = {
  /** epoch ms */
  ts: number
  /** feature label */
  f: OwnAiFeature
  /** model */
  m: string
  /** prompt tokens */
  p: number
  /** completion tokens */
  c: number
  /** total tokens */
  t: number
}

const USAGE_KEY = getStorageNS("own-ai-usage")
const RETENTION_MS = 90 * 86_400_000

const loadRecords = (): UsageRecord[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(USAGE_KEY) ?? "[]") as UsageRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const saveRecords = (records: UsageRecord[]) => {
  localStorage.setItem(USAGE_KEY, JSON.stringify(records))
}

const startOfDay = (d = new Date()) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const startOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1).getTime()

/**
 * Rough token estimate for providers that do not report usage:
 * CJK chars count ~0.75 tokens each, everything else ~4 chars per token.
 */
export const estimateTokens = (text: string): number => {
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) ?? []).length
  const other = text.length - cjk
  return Math.max(1, Math.round(cjk * 0.75 + other / 4))
}

export const recordOwnAiUsage = (entry: {
  feature: OwnAiFeature
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
}) => {
  try {
    const records = loadRecords()
    const now = Date.now()
    records.push({
      ts: now,
      f: entry.feature,
      m: entry.model,
      p: entry.promptTokens,
      c: entry.completionTokens,
      t: entry.totalTokens,
    })
    saveRecords(records.filter((r) => now - r.ts < RETENTION_MS))
  } catch {
    // stats must never break the feature
  }
}

export interface OwnAiUsageSummary {
  todayTokens: number
  todayCalls: number
  monthTokens: number
  monthCalls: number
  totalTokens: number
  totalCalls: number
  /** last 7 days, oldest first: [{ label: "MM-DD", tokens, calls }] */
  daily: { label: string; tokens: number; calls: number }[]
}

export const getOwnAiUsageSummary = (): OwnAiUsageSummary => {
  const records = loadRecords()
  const now = new Date()
  const day0 = startOfDay(now)
  const month0 = startOfMonth(now)

  const summary: OwnAiUsageSummary = {
    todayTokens: 0,
    todayCalls: 0,
    monthTokens: 0,
    monthCalls: 0,
    totalTokens: 0,
    totalCalls: 0,
    daily: [],
  }

  const dailyMap = new Map<string, { tokens: number; calls: number }>()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    dailyMap.set(
      `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      {
        tokens: 0,
        calls: 0,
      },
    )
  }

  for (const r of records) {
    summary.totalTokens += r.t
    summary.totalCalls += 1
    if (r.ts >= day0) {
      summary.todayTokens += r.t
      summary.todayCalls += 1
    }
    if (r.ts >= month0) {
      summary.monthTokens += r.t
      summary.monthCalls += 1
    }
    const label = new Date(r.ts).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" })
    const bucket = dailyMap.get(label)
    if (bucket) {
      bucket.tokens += r.t
      bucket.calls += 1
    }
  }
  summary.daily = [...dailyMap.entries()].map(([label, v]) => ({ label, ...v }))
  return summary
}
