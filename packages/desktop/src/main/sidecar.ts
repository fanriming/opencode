import { spawn, ChildProcess } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

function getParentPort(): ParentPort {
  const port =
    (process as unknown as { parentPort?: ParentPort }).parentPort ??
    (globalThis as unknown as { parentPort?: ParentPort }).parentPort
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}

const parentPort = getParentPort()
let childProcess: ChildProcess | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    const cliBinary = findCodefreeBinary()
    if (!cliBinary) {
      throw new Error("codefree-o CLI not found. Please install it globally: npm install -g @srdcloud/codefree-o")
    }

    const noProxy = buildNoProxyValue()

    childProcess = spawn(
      cliBinary,
      ["serve", "--hostname", command.hostname, "--port", String(command.port), "--cors", "oc://renderer"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: command.password,
          OPENCODE_SERVER_USERNAME: "opencode",
          XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? command.userDataPath,
          NO_PROXY: noProxy,
          no_proxy: noProxy.toLowerCase(),
        },
      },
    )

    childProcess.stdout?.on("data", (data: Buffer) => {
      console.log("[codefree-o stdout]", data.toString("utf8").trim())
    })

    childProcess.stderr?.on("data", (data: Buffer) => {
      console.error("[codefree-o stderr]", data.toString("utf8").trim())
    })

    childProcess.on("error", (error) => {
      parentPort.postMessage({ type: "error", error: serializeError(error) })
    })

    childProcess.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        parentPort.postMessage({
          type: "error",
          error: { message: `codefree-o exited with code ${code}` },
        })
      }
    })

    await waitForServerReady(command.hostname, command.port, command.password)
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    if (childProcess) {
      childProcess.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          childProcess?.kill("SIGKILL")
          resolve()
        }, 5000)
        childProcess?.on("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
      childProcess = undefined
    }
  } finally {
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function findCodefreeBinary(): string | null {
  const binName = process.platform === "win32" ? "codefree-o.exe" : "codefree-o"

  if (process.env.OPENCODE_BIN_PATH) {
    return process.env.OPENCODE_BIN_PATH
  }

  const pathEnv = process.env.PATH || ""
  const pathSep = process.platform === "win32" ? ";" : ":"

  for (const dir of pathEnv.split(pathSep)) {
    const candidate = path.join(dir, binName)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }

  return null
}

async function waitForServerReady(hostname: string, port: number, password: string): Promise<void> {
  const maxAttempts = 60
  const delayMs = 500
  const fetchTimeoutMs = 2000
  const totalTimeoutMs = maxAttempts * (fetchTimeoutMs + delayMs)

  const headers = new Headers()
  const auth = Buffer.from(`opencode:${password}`).toString("base64")
  headers.set("authorization", `Basic ${auth}`)

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const url = `http://${hostname}:${port}/global/health`
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(fetchTimeoutMs),
      })
      if (response.ok) {
        return
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  throw new Error(`Server did not become ready within ${totalTimeoutMs}ms`)
}

function buildNoProxyValue(): string {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
    for (const host of loopback) {
      if (items.some((v) => v.toLowerCase() === host)) continue
      items.push(host)
    }
    return items.join(",")
  }
  return upsert("NO_PROXY")
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}
