import { spawn } from 'node:child_process'

export interface GitExecOptions {
  /**
   * Maximum time in milliseconds before the child is killed. Use for
   * network-touching commands (fetch, clone) that can hang indefinitely —
   * e.g. git prompting on /dev/tty when launched from a terminal.
   */
  timeoutMs?: number
  /** Maximum combined stdout and stderr bytes to capture before stopping Git. */
  maxOutputBytes?: number
}

/**
 * Runs a git command in the given directory, returning stdout as a string.
 * Uses explicit stdio to avoid Electron EBADF issues when spawned from
 * a non-TTY context.
 */
export function gitExec(args: string[], cwd: string, options: GitExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []

    const { timeoutMs, maxOutputBytes = Infinity } = options
    let outputBytes = 0
    let failure: Error | undefined
    let timer: NodeJS.Timeout | undefined

    const stop = (error: Error): void => {
      if (failure) return
      failure = error
      if (timer) clearTimeout(timer)
      chunks.length = 0
      errChunks.length = 0
      child.kill('SIGKILL')
    }

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => stop(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
    }

    const collect = (target: Buffer[], data: Buffer): void => {
      if (failure) return
      outputBytes += data.length
      if (outputBytes > maxOutputBytes) {
        stop(new Error(`git ${args[0]} exceeded the ${maxOutputBytes} byte output limit`))
        return
      }
      target.push(data)
    }

    child.stdout!.on('data', (data: Buffer) => collect(chunks, data))
    child.stderr!.on('data', (data: Buffer) => collect(errChunks, data))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(failure ?? err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (failure) {
        reject(failure)
      } else if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8')
        reject(new Error(`git ${args[0]} failed (code ${code}): ${stderr}`))
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    })
  })
}
