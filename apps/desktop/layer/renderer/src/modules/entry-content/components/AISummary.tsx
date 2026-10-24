import { useEntry } from "@follow/store/entry/hooks"
import { usePrefetchSummary } from "@follow/store/summary/hooks"
import { cn } from "@follow/utils/utils"
import { useAtomValue } from "jotai"
import { useTranslation } from "react-i18next"

import { useShowAISummary } from "~/atoms/ai-summary"
import { useEntryIsInReadabilitySuccess } from "~/atoms/readability"
import { setAIPanelVisibility, useAIPanelVisibility, useOwnAIActive } from "~/atoms/settings/ai"
import { useActionLanguage } from "~/atoms/settings/general"
import { AISummaryCardBase } from "~/components/ui/ai-summary-card"
import { ownAISummaryStreamAtom } from "~/lib/own-ai"

export function AISummary({ entryId }: { entryId: string }) {
  const { t } = useTranslation()
  const summarySetting = useEntry(entryId, (state) => state.settings?.summary)
  const isInReadabilitySuccess = useEntryIsInReadabilitySuccess(entryId)
  const showAISummary = useShowAISummary(summarySetting)
  const ownAiActive = useOwnAIActive()

  const actionLanguage = useActionLanguage()

  // AI Chat panel state
  const isAIPanelVisible = useAIPanelVisibility()

  const summary = usePrefetchSummary({
    actionLanguage,
    entryId,
    target: isInReadabilitySuccess ? "readabilityContent" : "content",
    enabled: showAISummary,
  })

  // While Own AI is generating, render the partial summary as it streams in.
  const summaryStreams = useAtomValue(ownAISummaryStreamAtom)
  const streamingText = ownAiActive ? summaryStreams[entryId] : undefined
  const displayContent = summary.data || streamingText
  const isLoading = summary.isLoading && !displayContent

  // Ask AI only opens the AI panel, so it is left out while the panel is open, including a fixed
  // panel next to the entry once its chat has messages
  const shouldShowAskAI = !isAIPanelVisible

  const handleAskAI = () => {
    setAIPanelVisibility(true)
  }

  if (!showAISummary) {
    return null
  }

  return (
    <AISummaryCardBase
      content={displayContent}
      isLoading={isLoading}
      // Only a finished summary belongs in an exported PDF, not its loading, upgrade or empty state
      className={cn("my-8", !displayContent && "print:hidden")}
      title={
        ownAiActive ? `${t("entry_content.ai_summary")} · Own AI` : t("entry_content.ai_summary")
      }
      showAskAIButton={shouldShowAskAI}
      onAskAI={handleAskAI}
      error={summary.error}
    />
  )
}
