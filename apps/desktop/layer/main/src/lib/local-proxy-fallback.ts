import net from "node:net"

import { env } from "@follow/shared/env.desktop"
import { session } from "electron"

import { logger } from "../logger"

/**
 * Local proxy auto-fallback for censored networks.
 *
 * The app reaches api.follow.is through the system proxy when one is
 * configured. Where the system proxy is unavailable (e.g. the user's proxy
 * client runs but "system proxy" is toggled off), direct connections to the
 * API can black-hole — every request dies in the 10s abort timeout and the
 * app reports "no network" even though AI endpoints (domestic providers)
 * still work.
 *
 * When the system has no proxy and a well-known local proxy port is alive,
 * route the default session through it. Re-evaluated periodically: system
 * proxy takes precedence again as soon as it exists, and the fallback is
 * dropped if the local proxy port dies.
 */

const PROBE_TARGET_URL = new URL(env.VITE_API_URL)
const LOCAL_PROXY_CANDIDATES = ["127.0.0.1:7890", "127.0.0.1:7897"]
const RECHECK_INTERVAL_MS = 5 * 60_000
const PORT_PROBE_TIMEOUT_MS = 1_500

let appliedCandidate: string | null = null
let recheckTimer: NodeJS.Timeout | null = null

const isSystemProxyConfigured = async () => {
  // With our own override applied this would only echo it back, so callers
  // must skip this check while an override is active.
  const proxy = await session.defaultSession.resolveProxy(
    `${PROBE_TARGET_URL.protocol}//${PROBE_TARGET_URL.host}`,
  )
  return /PROXY|SOCKS/i.test(proxy)
}

const isPortAlive = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = new net.Socket()
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, PORT_PROBE_TIMEOUT_MS)
    socket.once("connect", () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
    socket.connect(port, host)
  })

const evaluate = async () => {
  if (appliedCandidate) {
    // Fallback active: drop it as soon as the local proxy port disappears,
    // the next tick re-evaluates the system proxy.
    const [host, port] = appliedCandidate.split(":")
    if (!(await isPortAlive(host!, Number(port!)))) {
      logger.info("[proxy-fallback] local proxy port died, restoring system proxy")
      appliedCandidate = null
      await session.defaultSession.setProxy({ mode: "system" })
    }
    return
  }

  if (await isSystemProxyConfigured()) return

  for (const candidate of LOCAL_PROXY_CANDIDATES) {
    const [host, port] = candidate.split(":")
    if (await isPortAlive(host!, Number(port!))) {
      await session.defaultSession.setProxy({
        mode: "fixed_servers",
        proxyRules: candidate,
      })
      appliedCandidate = candidate
      logger.info(
        `[proxy-fallback] system proxy off, routing ${PROBE_TARGET_URL.host} traffic through local proxy ${candidate}`,
      )
      return
    }
  }
}

export const startLocalProxyFallback = () => {
  void evaluate().catch((error) => {
    logger.error("[proxy-fallback] initial evaluation failed:", error)
  })
  recheckTimer = setInterval(() => {
    void evaluate().catch((error) => {
      logger.error("[proxy-fallback] re-evaluation failed:", error)
    })
  }, RECHECK_INTERVAL_MS)
}

export const stopLocalProxyFallback = () => {
  if (recheckTimer) {
    clearInterval(recheckTimer)
    recheckTimer = null
  }
}
