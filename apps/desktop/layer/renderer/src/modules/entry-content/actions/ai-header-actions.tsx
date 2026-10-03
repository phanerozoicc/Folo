import { ActionButton } from "@follow/components/ui/button/index.js"
import { RotatingRefreshIcon } from "@follow/components/ui/loading/index.jsx"
import { getEntry } from "@follow/store/entry/getter"
import { translationActions } from "@follow/store/translation/store"
import { checkLanguage } from "@follow/utils/language"
import { useQueryClient } from "@tanstack/react-query"
import { memo } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  disableShowAISummaryOnce,
  enableShowAISummaryOnce,
  useShowAISummaryOnce,
} from "~/atoms/ai-summary"
import { toggleShowAITranslationOnce, useShowAITranslationOnce } from "~/atoms/ai-translation"
import { useActionLanguage, useGeneralSettingKey } from "~/atoms/settings/general"
import { useEntryContent } from "~/modules/entry-content/hooks"

/**
 * Manual triggers for AI summary and translation on the current entry.
 * Summary is shown while auto summary is off. The translate button is always
 * shown: with auto translation off it toggles the once-mode, with auto
 * translation on it clears this entry's cached translations and regenerates
 * them through Own AI. The icon spins while a generation is in flight.
 */
export const AiHeaderActions = memo(({ entryId }: { entryId: string }) => {
  const { t } = useTranslation("ai")
  const queryClient = useQueryClient()

  const summaryAuto = useGeneralSettingKey("summary")
  const translationAuto = useGeneralSettingKey("translation")
  const actionLanguage = useActionLanguage()
  const summaryOnce = useShowAISummaryOnce()
  const translationOnce = useShowAITranslationOnce()
  const { isTranslating } = useEntryContent(entryId)

  const handleTranslate = () => {
    // The pipeline skips entries whose source language already equals the
    // target language (e.g. Chinese article, Chinese UI) without firing any
    // request. Surface that instead of doing nothing.
    const entry = getEntry(entryId) as Record<string, unknown> | null
    const candidates = [
      entry?.title,
      entry?.description,
      (entry?.readabilityContent as string | undefined) ?? (entry?.content as string | undefined),
    ]
    const hasTranslatable = candidates.some(
      (value) =>
        typeof value === "string" &&
        value.trim().length > 0 &&
        !checkLanguage({ content: value, language: actionLanguage }),
    )
    if (!hasTranslatable) {
      toast.info(t("translation_not_needed"))
      return
    }
    if (translationAuto) {
      // Auto translation is on: drop this entry's cached translations and
      // regenerate them through Own AI.
      translationActions.clearEntry(entryId)
      void queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey[0] === "translation" &&
          query.queryKey[1] === entryId,
      })
      return
    }
    toggleShowAITranslationOnce()
  }

  return (
    <div className="relative flex shrink-0 items-center gap-1">
      {!summaryAuto && (
        <ActionButton
          tooltip={t("ai_summary")}
          active={summaryOnce}
          onClick={() => (summaryOnce ? disableShowAISummaryOnce() : enableShowAISummaryOnce())}
        >
          <i className="i-mgc-magic-2-cute-re size-4" />
        </ActionButton>
      )}
      <ActionButton
        tooltip={
          isTranslating
            ? t("translation_in_progress")
            : translationAuto
              ? t("retranslate_entry")
              : t("entry_content.ai_translation_once")
        }
        active={translationOnce || isTranslating}
        onClick={handleTranslate}
      >
        {isTranslating ? (
          <RotatingRefreshIcon isRefreshing className="size-4 text-accent" />
        ) : (
          <i className="i-mgc-translate-2-ai-cute-re size-4" />
        )}
      </ActionButton>
    </div>
  )
})
