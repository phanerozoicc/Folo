import { ActionButton } from "@follow/components/ui/button/index.js"
import { memo } from "react"
import { useTranslation } from "react-i18next"

import {
  disableShowAISummaryOnce,
  enableShowAISummaryOnce,
  useShowAISummaryOnce,
} from "~/atoms/ai-summary"
import { toggleShowAITranslationOnce, useShowAITranslationOnce } from "~/atoms/ai-translation"
import { useGeneralSettingKey } from "~/atoms/settings/general"

/**
 * Manual triggers for AI summary and translation on the current entry.
 * Only rendered while the corresponding automation is off — when the
 * general setting is on, the summary card / list translations appear by
 * themselves and these buttons would be redundant.
 */
export const AiHeaderActions = memo(({ entryId: _entryId }: { entryId: string }) => {
  const { t } = useTranslation("ai")

  const summaryAuto = useGeneralSettingKey("summary")
  const translationAuto = useGeneralSettingKey("translation")
  const summaryOnce = useShowAISummaryOnce()
  const translationOnce = useShowAITranslationOnce()

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
      {!translationAuto && (
        <ActionButton
          tooltip={t("entry_content.ai_translation_once")}
          active={translationOnce}
          onClick={() => toggleShowAITranslationOnce()}
        >
          <i className="i-mgc-translate-2-ai-cute-re size-4" />
        </ActionButton>
      )}
    </div>
  )
})
