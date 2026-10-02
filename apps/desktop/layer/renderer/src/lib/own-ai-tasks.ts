import { getStorageNS } from "@follow/utils/ns"

import { chatCompletion, stripHtml } from "./own-ai"

// ---------------------------------------------------------------------------
// Local AI tasks (daily report etc.): the task system runs entirely on this
// device against the user's Own AI endpoint.
// ---------------------------------------------------------------------------

type LocalTaskSchedule =
  | { type: "once"; date: string }
  | { type: "daily"; timeOfDay: string }
  | { type: "weekly"; dayOfWeek: number; timeOfDay: string }
  | { type: "monthly"; dayOfMonth: number; timeOfDay: string }

type LocalTask = {
  id: string
  name: string
  prompt: string
  isEnabled: boolean
  schedule: LocalTaskSchedule
  options: { notifyChannels?: string[] }
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  nextRunAt: string | null
  runCount: number
  lastResult: string | null
  lastError: string | null
}

const TASKS_KEY = getStorageNS("own-ai-tasks")

const loadTasks = (): LocalTask[] => {
  try {
    return JSON.parse(localStorage.getItem(TASKS_KEY) ?? "[]") as LocalTask[]
  } catch {
    return []
  }
}

const saveTasks = (tasks: LocalTask[]) => {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks))
}

const toLocalTask = (input: {
  name: string
  prompt: string
  isEnabled?: boolean
  schedule: LocalTaskSchedule
  options?: { notifyChannels?: string[] }
}): LocalTask => {
  const now = new Date().toISOString()
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name,
    prompt: input.prompt,
    isEnabled: input.isEnabled ?? true,
    schedule: input.schedule,
    options: input.options ?? {},
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    nextRunAt: computeNextRunAt(input.schedule),
    runCount: 0,
    lastResult: null,
    lastError: null,
  }
}

const timeParts = (iso: string) => {
  const d = new Date(iso)
  return { hours: d.getHours(), minutes: d.getMinutes() }
}

const atTime = (base: Date, hours: number, minutes: number) => {
  const d = new Date(base)
  d.setHours(hours, minutes, 0, 0)
  return d
}

export const computeNextRunAt = (schedule: LocalTaskSchedule, from = new Date()): string => {
  if (schedule.type === "once") return schedule.date

  const { hours, minutes } = timeParts(schedule.timeOfDay)
  const next = new Date(from)
  next.setSeconds(0, 0)

  if (schedule.type === "daily") {
    const today = atTime(next, hours, minutes)
    return (today > next ? today : new Date(today.getTime() + 86_400_000)).toISOString()
  }

  if (schedule.type === "weekly") {
    for (let i = 0; i < 8; i++) {
      const candidate = atTime(new Date(next.getTime() + i * 86_400_000), hours, minutes)
      if (candidate.getDay() === schedule.dayOfWeek && candidate > next)
        return candidate.toISOString()
    }
    return next.toISOString()
  }

  // monthly
  for (let i = 0; i < 31; i++) {
    const candidate = new Date(next)
    candidate.setDate(candidate.getDate() + i)
    candidate.setHours(hours, minutes, 0, 0)
    const day =
      candidate.getDate() === schedule.dayOfMonth
        ? candidate
        : new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0, hours, minutes)
    if (day > next) return day.toISOString()
  }
  return next.toISOString()
}

const isTaskDue = (task: LocalTask, now = new Date()): boolean => {
  if (!task.isEnabled) return false

  if (task.schedule.type === "once") {
    return !task.lastRunAt && new Date(task.schedule.date) <= now
  }

  const { hours, minutes } = timeParts(task.schedule.timeOfDay)
  const scheduledToday = atTime(now, hours, minutes)
  if (scheduledToday > now) return false

  if (task.lastRunAt && new Date(task.lastRunAt) >= scheduledToday) return false

  if (task.schedule.type === "weekly") {
    return now.getDay() === task.schedule.dayOfWeek
  }
  if (task.schedule.type === "monthly") {
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    return now.getDate() === Math.min(task.schedule.dayOfMonth, lastDayOfMonth)
  }
  return true
}

const collectRecentEntriesDigest = async (limit = 40): Promise<string> => {
  const { followApi } = await import("./api-client")
  const res = await followApi.entries.list({ limit } as never)
  const entries = (Array.isArray(res?.data) ? res.data : []) as {
    entries?: { title?: string; description?: string; publishedAt?: string }
    feeds?: { title?: string }
  }[]

  return entries
    .map((item, index) => {
      const feedTitle = item.feeds?.title ?? ""
      const title = item.entries?.title ?? ""
      const publishedAt = item.entries?.publishedAt
        ? String(item.entries.publishedAt).slice(0, 10)
        : ""
      const description = stripHtml(item.entries?.description ?? "")
      return `${index + 1}. [${feedTitle}] ${title} (${publishedAt}) — ${description}`
    })
    .join("\n")
}

const runTask = async (task: LocalTask): Promise<void> => {
  const tasks = loadTasks()
  const current = tasks.find((t) => t.id === task.id)
  if (!current) return

  try {
    const digest = await collectRecentEntriesDigest()
    const content = await chatCompletion({
      temperature: 0.5,
      system:
        "You are the user's personal RSS reading assistant. Fulfil the user's request based on the recent entries provided. Respond in the same language as the user's request. Markdown is supported.",
      prompt: `${task.prompt}\n\n---\nRecent entries:\n${digest || "(no recent entries)"}`,
    })

    current.lastResult = content
    current.lastError = null
    current.runCount += 1
  } catch (error) {
    current.lastError = String(error).slice(0, 500)
  }

  current.lastRunAt = new Date().toISOString()
  if (current.schedule.type === "once") {
    current.isEnabled = false
    current.nextRunAt = null
  } else {
    current.nextRunAt = computeNextRunAt(current.schedule)
  }
  current.updatedAt = current.lastRunAt

  saveTasks(tasks.map((t) => (t.id === current.id ? current : t)))

  if (current.lastResult) {
    try {
      const notification = new Notification(current.name, {
        body: current.lastResult.replace(/\s+/g, " ").slice(0, 120),
      })
      notification.onclick = () => {
        window.focus()
        notification.close()
      }
    } catch {
      // notifications unavailable; result stays visible in the task list
    }
  }
}

let schedulerStarted = false
export const startOwnAITaskScheduler = () => {
  if (schedulerStarted) return
  schedulerStarted = true

  const tick = () => {
    if (typeof window === "undefined") return
    for (const task of loadTasks()) {
      if (isTaskDue(task)) {
        void runTask(task)
      }
    }
  }

  window.setInterval(tick, 60_000)
  window.setTimeout(tick, 15_000)
}

// ---------------------------------------------------------------------------
// HTTP routing: serve /ai/task* requests from the local store
// ---------------------------------------------------------------------------

const taskResponse = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const errorResponse = (status: number, message: string) =>
  new Response(JSON.stringify({ code: status, message }), {
    status,
    headers: { "content-type": "application/json" },
  })

export const handleAiTaskRequest = async ({
  method,
  pathname,
  body,
}: {
  method: string
  pathname: string
  body?: unknown
}): Promise<Response | null> => {
  const path = pathname.replace(/\/+$/, "") || "/"

  if (path === "/ai/task") {
    if (method === "GET") {
      return taskResponse(loadTasks())
    }
    if (method === "POST") {
      const input = body as {
        name: string
        prompt: string
        isEnabled?: boolean
        schedule: LocalTaskSchedule
        options?: { notifyChannels?: string[] }
      }
      if (!input?.name || !input?.prompt) {
        return errorResponse(400, "name and prompt are required")
      }
      const task = toLocalTask(input)
      const tasks = loadTasks()
      tasks.unshift(task)
      saveTasks(tasks)
      return taskResponse(task)
    }
    return null
  }

  const testRunMatch = path.match(/^\/ai\/task\/([^/]+)\/test-run$/)
  if (testRunMatch) {
    if (method !== "POST") return null
    const id = decodeURIComponent(testRunMatch[1]!)
    const task = loadTasks().find((t) => t.id === id)
    if (!task) return errorResponse(404, `Task ${id} not found`)
    await runTask(task)
    const updated = loadTasks().find((t) => t.id === id)
    return taskResponse({
      taskId: id,
      result: updated?.lastResult ?? undefined,
      error: updated?.lastError ?? undefined,
    })
  }

  const idMatch = path.match(/^\/ai\/task\/([^/]+)$/)
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]!)

    if (method === "GET") {
      const task = loadTasks().find((t) => t.id === id)
      return task ? taskResponse(task) : errorResponse(404, `Task ${id} not found`)
    }

    if (method === "PUT") {
      const tasks = loadTasks()
      const task = tasks.find((t) => t.id === id)
      if (!task) return errorResponse(404, `Task ${id} not found`)
      const input = body as {
        name?: string
        prompt?: string
        isEnabled?: boolean
        schedule?: LocalTaskSchedule
        options?: { notifyChannels?: string[] }
      }
      if (input?.name !== undefined) task.name = input.name
      if (input?.prompt !== undefined) task.prompt = input.prompt
      if (input?.isEnabled !== undefined) task.isEnabled = input.isEnabled
      if (input?.options !== undefined) task.options = input.options
      if (input?.schedule !== undefined) {
        task.schedule = input.schedule
        task.nextRunAt = task.isEnabled ? computeNextRunAt(input.schedule) : null
      }
      task.updatedAt = new Date().toISOString()
      saveTasks(tasks)
      return taskResponse(task)
    }

    if (method === "DELETE") {
      saveTasks(loadTasks().filter((t) => t.id !== id))
      return taskResponse(null)
    }
  }

  return null
}
