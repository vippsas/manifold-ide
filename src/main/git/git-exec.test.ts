import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

const { spawn: mockSpawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ default: { spawn: mockSpawn }, spawn: mockSpawn }))

import { gitExec } from './git-exec'

/** A child that never closes on its own; records whether kill() was called. */
function hangingChild(): ChildProcess & { killed: boolean } {
  const emitter = new EventEmitter() as ChildProcess & { killed: boolean }
  Object.assign(emitter, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    kill: vi.fn(function (this: typeof emitter) {
      this.killed = true
      // Simulate the OS reaping the killed process.
      process.nextTick(() => emitter.emit('close', null))
      return true
    }),
  })
  return emitter
}

function fastChild(stdout = ''): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
  process.nextTick(() => {
    if (stdout) (emitter.stdout as EventEmitter).emit('data', Buffer.from(stdout))
    emitter.emit('close', 0)
  })
  return emitter
}

describe('gitExec timeout', () => {
  it('kills the child and rejects when the timeout elapses', async () => {
    const child = hangingChild()
    mockSpawn.mockReturnValueOnce(child)

    await expect(gitExec(['fetch', '--all'], '/repo', { timeoutMs: 10 })).rejects.toThrow(/timed out after 10ms/)
    expect(child.killed).toBe(true)
  })

  it('does not arm a timer when no timeout is given (resolves normally)', async () => {
    mockSpawn.mockReturnValueOnce(fastChild('ok\n'))
    await expect(gitExec(['status'], '/repo')).resolves.toBe('ok\n')
  })

  it('resolves before the timeout for a fast command', async () => {
    mockSpawn.mockReturnValueOnce(fastChild('done\n'))
    await expect(gitExec(['status'], '/repo', { timeoutMs: 5000 })).resolves.toBe('done\n')
  })
})

describe('gitExec output limit', () => {
  it('returns output that fits the byte limit', async () => {
    mockSpawn.mockReturnValueOnce(fastChild('été'))

    await expect(gitExec(['diff'], '/repo', { maxOutputBytes: 5 })).resolves.toBe('été')
  })

  it('kills the child when its combined output exceeds the byte limit', async () => {
    const child = hangingChild()
    mockSpawn.mockReturnValueOnce(child)
    const result = gitExec(['diff'], '/repo', { maxOutputBytes: 5 })

    const stdout = child.stdout as EventEmitter
    const stderr = child.stderr as EventEmitter
    stdout.emit('data', Buffer.from('été'))
    expect(child.killed).toBe(false)
    stderr.emit('data', Buffer.from('!'))
    // A successful child exit still cannot return a partial patch.
    child.emit('close', 0)

    await expect(result).rejects.toThrow('git diff exceeded the 5 byte output limit')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
