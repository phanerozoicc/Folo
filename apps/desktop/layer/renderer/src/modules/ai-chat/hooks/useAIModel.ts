import { useEffect, useMemo } from "react"

import { setAIModelState, useAIModelState } from "../atoms/session"
import { useAIConfiguration } from "./useAIConfiguration"

export const useAIModel = () => {
  const { data: configuration, isLoading } = useAIConfiguration()
  const modelState = useAIModelState()

  // Validate and sync persistent model with available models
  useEffect(() => {
    if (!configuration || isLoading) return

    const { selectedModel } = modelState
    const { defaultModel, availableModels = [] } = configuration
    const fallback = defaultModel || null

    // If no model is selected or selected model is not available, use default.
    // Writing the same value must be skipped: modelState is a fresh object per
    // write, so an unconditional write here loops forever when defaultModel is
    // undefined (which renders every consumer on each pass).
    if (
      (!selectedModel || !availableModels.includes(selectedModel)) &&
      fallback !== selectedModel
    ) {
      setAIModelState({
        selectedModel: fallback,
      })
    }
  }, [configuration, isLoading, modelState])

  // Get current effective model
  const currentModel = useMemo(() => {
    if (!configuration) return null

    const { selectedModel } = modelState
    const { defaultModel, availableModels = [] } = configuration

    // Return selected model if valid, otherwise fallback to default
    if (selectedModel && availableModels.includes(selectedModel)) {
      return selectedModel
    }

    return defaultModel || null
  }, [configuration, modelState])

  const changeModel = (model: string) => {
    if (!configuration?.availableModels?.includes(model)) {
      console.warn(`Model ${model} is not available in current configuration`)
      return
    }

    setAIModelState({
      selectedModel: model,
    })
  }

  return {
    data: {
      defaultModel: configuration?.defaultModel,
      availableModels: configuration?.availableModels,
      availableModelsMenu: configuration?.availableModelsMenu,
      currentModel,
    },
    isLoading,
    changeModel,
  }
}
