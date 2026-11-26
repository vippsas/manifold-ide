import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

// A checkout whose build output is not ignored (a deleted .gitignore, a fresh
// `cargo build`) reports tens of thousands of untracked files. getDiff used to
// spawn one `git diff --no-index` per file and buffer every result, which ran
// the main process out of heap. These tests pin the budget that stops that.

const { spawnMock, execFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
}))

vi.mock('node:fs', () => ({
  default: { existsSync: () => true },
  existsSync: () => true,
}))

vi.mock('node:child_process', () => ({
  default: { spawn: spawnMock, execFile: execFileMock },
  execFile: execFileMock,
  spawn: spawnMock,
}))

import {
  DiffProvider,
  MAX_UNTRACKED_DIFF_CHARS,
  MAX_UNTRACKED_DIFF_FILES,
} from './diff-provider'

function queueSpawn(stdout: string): void {
  spawnMock.mockImplementationOnce(() => {
    const emitter = new EventEmitter()
    const stdoutEmitter = new EventEmitter()
    Object.assign(emitter, { stdout: stdoutEmitter, stderr: new EventEmitter(), kill: vi.fn() })
    process.nextTick(() => {
      if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout))
      emitter.emit('close', 0)
    })
    return emitter as unknown as ChildProcess
  })
}

function untrackedFiles(count: number): string {
  return Array.from({ length: count }, (_, i) => `target/debug/file-${i}.o`).join('\0') + '\0'
}

/** Every `git diff --no-index` answers with `stdout`, as real git does. */
function answerUntrackedDiffsWith(stdout: (filePath: string) => string): void {
  execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
    callback?.(null, { stdout: stdout(args[args.length - 1]), stderr: '' })
    return {} as ChildProcess
  })
}

describe('DiffProvider.getDiff untracked-file budget', () => {
  let provider: DiffProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new DiffProvider()
  })

  it('includes the tracked patch and every untracked diff within budget', async () => {
    queueSpawn('diff --git a/tracked.txt b/tracked.txt\n')
    queueSpawn(untrackedFiles(3))
    answerUntrackedDiffsWith((file) => `diff --git a/${file} b/${file}`)

    const diff = await provider.getDiff('/worktree', 'main')

    expect(execFileMock).toHaveBeenCalledTimes(3)
    expect(diff.split('\n')).toHaveLength(4)
    expect(diff).toMatch(/^diff --git a\/tracked\.txt b\/tracked\.txt\n/)
  })

  it('keeps untracked previews when a tracked diff exceeds the output budget', async () => {
    queueSpawn('x'.repeat(10 * 1024 * 1024 + 1))
    queueSpawn(untrackedFiles(1))
    answerUntrackedDiffsWith((file) => `diff --git a/${file} b/${file}`)

    const diff = await provider.getDiff('/worktree', 'main')

    expect(diff.length).toBeLessThan(100)
    expect(diff).toBe('diff --git a/target/debug/file-0.o b/target/debug/file-0.o')
    expect(spawnMock.mock.results[0].value.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('stops spawning a diff per file once the file budget is spent', async () => {
    queueSpawn('')
    queueSpawn(untrackedFiles(37_589))
    answerUntrackedDiffsWith((file) => `diff --git a/${file} b/${file}`)

    const diff = await provider.getDiff('/worktree', 'main')

    expect(execFileMock).toHaveBeenCalledTimes(MAX_UNTRACKED_DIFF_FILES)
    expect(diff.split('\n')).toHaveLength(MAX_UNTRACKED_DIFF_FILES)
  })

  it('stops once the buffered untracked diff text reaches the size budget', async () => {
    const chunk = 'x'.repeat(1024 * 1024)
    queueSpawn('')
    queueSpawn(untrackedFiles(MAX_UNTRACKED_DIFF_FILES))
    answerUntrackedDiffsWith(() => chunk)

    const diff = await provider.getDiff('/worktree', 'main')

    const expectedFiles = Math.ceil(MAX_UNTRACKED_DIFF_CHARS / chunk.length)
    expect(execFileMock).toHaveBeenCalledTimes(expectedFiles)
    expect(diff.length).toBeLessThan(MAX_UNTRACKED_DIFF_CHARS + chunk.length)
  })

  it('still lists every untracked file as a change', async () => {
    queueSpawn('') // own paths: <base>...HEAD
    queueSpawn('') // own paths: HEAD
    queueSpawn('') // name-status
    queueSpawn(untrackedFiles(MAX_UNTRACKED_DIFF_FILES + 50))

    const changes = await provider.getChangedFiles('/worktree', 'main')

    expect(changes).toHaveLength(MAX_UNTRACKED_DIFF_FILES + 50)
  })
})
