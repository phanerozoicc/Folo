import { Card, CardContent } from "@follow/components/ui/card/index.jsx"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"

import { useOwnAIActive } from "~/atoms/settings/ai"
import type { OwnAiUsageSummary } from "~/lib/own-ai-usage"
import { getOwnAiUsageSummary } from "~/lib/own-ai-usage"

const formatTokens = (n: number) => {
  if (!Number.isFinite(n)) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

const fetchSummary = (): Promise<OwnAiUsageSummary> => Promise.resolve(getOwnAiUsageSummary())

export const OwnAiUsageSection = () => {
  const { t } = useTranslation("ai")
  const ownAiActive = useOwnAIActive()
  const { data: summary } = useQuery({
    queryKey: ["ownAiUsage"],
    queryFn: fetchSummary,
    refetchInterval: 30_000,
    enabled: ownAiActive,
  })

  if (!ownAiActive || !summary) return null

  const stats = [
    { label: t("own_ai_usage.today"), tokens: summary.todayTokens, calls: summary.todayCalls },
    { label: t("own_ai_usage.month"), tokens: summary.monthTokens, calls: summary.monthCalls },
    { label: t("own_ai_usage.total"), tokens: summary.totalTokens, calls: summary.totalCalls },
  ]
  const maxDaily = Math.max(1, ...summary.daily.map((d) => d.tokens))

  return (
    <div className="-ml-3 space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-3 gap-3">
            {stats.map((stat) => (
              <div key={stat.label} className="space-y-1">
                <div className="text-xs text-text-tertiary">{stat.label}</div>
                <div className="text-lg font-semibold text-text">{formatTokens(stat.tokens)}</div>
                <div className="text-xs text-text-tertiary">
                  {t("own_ai_usage.calls", { count: stat.calls })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex h-12 items-end gap-1.5">
            {summary.daily.map((day) => (
              <div key={day.label} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-sm bg-accent/40"
                  style={{
                    height: `${Math.max(day.tokens > 0 ? 8 : 2, (day.tokens / maxDaily) * 40)}px`,
                  }}
                  title={`${day.label}: ${formatTokens(day.tokens)} (${day.calls})`}
                />
                <span className="text-[10px] text-text-tertiary">{day.label.slice(3)}</span>
              </div>
            ))}
          </div>

          <p className="mt-3 text-xs text-text-tertiary">{t("own_ai_usage.description")}</p>
        </CardContent>
      </Card>
    </div>
  )
}
