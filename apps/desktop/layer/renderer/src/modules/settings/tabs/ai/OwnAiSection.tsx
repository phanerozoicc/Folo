import { Button } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { setAISetting, useAISettingValue } from "~/atoms/settings/ai"
import { ipcServices } from "~/lib/client"

import { SettingDescription, SettingSwitch } from "../../control"

export const OwnAiSection = () => {
  const { t } = useTranslation("ai")
  const aiSettings = useAISettingValue()
  const ownAi = aiSettings.ownAi ?? { enabled: false, baseURL: "", apiKey: "", model: "" }

  const update = (patch: Partial<typeof ownAi>) => {
    setAISetting("ownAi", { ...ownAi, ...patch })
  }

  const handleTest = async () => {
    if (!ownAi.baseURL || !ownAi.model) {
      toast.error(t("own_ai.test.missing_config"))
      return
    }
    const toastId = toast.loading(t("own_ai.test.running"))
    try {
      const service = ipcServices?.ownAi
      if (!service) throw new Error("Desktop only")
      const { content } = await service.chatCompletion({
        apiKey: ownAi.apiKey,
        baseURL: ownAi.baseURL,
        model: ownAi.model,
        prompt: "Reply with the single word: OK",
      })
      toast.success(t("own_ai.test.success", { content: content.trim().slice(0, 50) }), {
        id: toastId,
      })
    } catch (error) {
      toast.error(t("own_ai.test.failed", { error: String(error).slice(0, 200) }), {
        id: toastId,
      })
    }
  }

  return (
    <div className="space-y-4">
      <SettingSwitch
        checked={ownAi.enabled}
        onCheckedChange={(enabled) => update({ enabled })}
        label={t("own_ai.enabled")}
      />
      {ownAi.enabled && <SettingDescription>{t("own_ai.enabled_description")}</SettingDescription>}

      {ownAi.enabled && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Input
              value={ownAi.baseURL}
              onChange={(e) => update({ baseURL: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
            <SettingDescription>{t("own_ai.base_url_description")}</SettingDescription>
          </div>

          <div className="space-y-1.5">
            <Input
              value={ownAi.model}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="gpt-4o-mini"
            />
            <SettingDescription>{t("own_ai.model_description")}</SettingDescription>
          </div>

          <div className="space-y-1.5">
            <Input
              type="password"
              value={ownAi.apiKey}
              onChange={(e) => update({ apiKey: e.target.value })}
              placeholder={t("own_ai.api_key_placeholder")}
            />
            <SettingDescription>{t("own_ai.api_key_description")}</SettingDescription>
          </div>

          <Button size="sm" variant="outline" onClick={handleTest}>
            {t("own_ai.test.button")}
          </Button>
        </div>
      )}
    </div>
  )
}
