import type { SupportedActionLanguage } from "@follow/shared/language"
import { ACTION_LANGUAGE_MAP } from "@follow/shared/language"
import { franc } from "franc-min"

import { parseHtml } from "./html"
import { duplicateIfLengthLessThan } from "./utils"

const detectableLanguageCodes = Object.values(ACTION_LANGUAGE_MAP).flatMap(({ code }) =>
  code ? [code] : [],
)

export const checkLanguage = ({
  content,
  language,
}: {
  content: string
  language: SupportedActionLanguage
}) => {
  if (!content) return true
  const pureContent = parseHtml(content)
    .toText()
    .replaceAll(/https?:\/\/\S+|www\.\S+/g, " ")
  const { code } = ACTION_LANGUAGE_MAP[language]
  if (!code) {
    return false
  }

  // 中英混排（如 "企业级 Agent Infra 架构实践｜QCon上海"）会让 franc 误判成英文，
  // 导致中文内容被送去做无意义的中文→中文"翻译"。CJK 占比高即视为中文源。
  // 含假名的文本是日语（汉字同样落在 CJK 区间），不套用此捷径。
  const cjkChars = pureContent.match(/[\u4e00-\u9fff]/g)?.length ?? 0
  const hasKana = /[\u3040-\u30ff]/.test(pureContent)
  if (code === "cmn" && cjkChars > 0 && !hasKana) {
    const cjkRatio = cjkChars / Math.max(pureContent.replace(/\s/g, "").length, 1)
    if (cjkRatio >= 0.3) return true
  }

  const sourceLanguage = franc(duplicateIfLengthLessThan(pureContent, 20), {
    only: detectableLanguageCodes,
  })

  return sourceLanguage === code
}
