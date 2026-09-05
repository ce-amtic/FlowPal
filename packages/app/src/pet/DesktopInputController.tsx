import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api.ts'
import { bridge } from '../bridge.ts'
import { dispatchDesktopInput, subscribeDesktopInput, type DesktopInput } from './input-dispatcher.ts'
import { usePetStatus } from './context.tsx'

/**
 * Converts native input notifications into the same fragment/run API used by
 * Composer. It lives once in the app shell, so a hotkey or a drop cannot be
 * processed twice when both the inline and resident renderer are present.
 */
export function DesktopInputController() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { setStatus } = usePetStatus()
  const queue = useRef<Promise<void>>(Promise.resolve())

  const enqueue = useCallback((job: () => Promise<void>) => {
    queue.current = queue.current.then(job, job)
  }, [])

  const captureClipboard = useCallback(async (source: 'pet' | 'hotkey') => {
    setStatus('receiving', { message: '正在读取剪贴板…' })
    try {
      const rawText = await bridge.readClipboard()
      const text = rawText.trim()
      const imagePath = !text ? await bridge.readClipboardImage?.() : null
      if (!text && !imagePath) {
        setStatus('error', { message: '剪贴板里没有可记录的文字或图片。' })
        dispatchDesktopInput({ type: 'receipt', message: '剪贴板里没有可记录的文字或图片。', error: true })
        return
      }
      if (source === 'pet') navigate('/now')
      setStatus('processing', { message: '正在提取日程…' })
      const result = await api.throwIn({
        source: source === 'pet' ? 'paste' : 'hotkey',
        rawType: imagePath ? 'image' : 'text',
        ...(imagePath ? { rawBlobPath: imagePath } : { rawText }),
      })
      const message = result.run.message || '接住了。原文已存。'
      const failed = result.run.status !== 'done'
      setStatus(failed ? 'error' : 'done', { message })
      dispatchDesktopInput({ type: 'receipt', message, error: failed })
      await queryClient.invalidateQueries()
      resetStatusSoon(setStatus, failed ? 'error' : 'done')
    } catch (cause) {
      const message = toMessage(cause)
      setStatus('error', { message })
      dispatchDesktopInput({ type: 'receipt', message, error: true })
    }
  }, [navigate, queryClient, setStatus])

  const captureFiles = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    navigate('/now')
    setStatus('receiving', { message: `收到 ${paths.length} 个文件…` })
    let completed = 0
    let failed = 0
    for (const path of paths) {
      try {
        setStatus('processing', { message: `正在读取 ${basename(path)}…` })
        // Preserve image drops as image fragments so the server can route them
        // to the vision model.  Treating every path as `file` makes the local
        // file reader reject png/jpg before the agent ever sees the bytes.
        const result = await api.throwIn({
          source: 'drop',
          rawType: rawTypeForPath(path),
          rawBlobPath: path,
        })
        if (result.run.status === 'done') completed += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
    await queryClient.invalidateQueries()
    const message = failed === 0
      ? `已接住 ${completed} 个文件。`
      : `已接住 ${completed} 个文件，${failed} 个需要稍后处理。`
    setStatus(failed === paths.length ? 'error' : 'done', { message })
    dispatchDesktopInput({ type: 'receipt', message, error: failed === paths.length })
    resetStatusSoon(setStatus, failed === paths.length ? 'error' : 'done')
  }, [navigate, queryClient, setStatus])

  useEffect(() => {
    const removeHotkey = bridge.onHotkeyOpen(() => {
      // The global shortcut is an input action, not merely a window toggle.
      // Route first so the Composer is available even when another page was
      // visible, then read the clipboard through the same queue as pet input.
      void bridge.openMain?.('/now')
      navigate('/now', { state: { focusComposer: false } })
      enqueue(() => captureClipboard('hotkey'))
    })
    const removeDrop = bridge.onFilesDropped((paths) => {
      dispatchDesktopInput({ type: 'files', paths, source: 'drop' })
    })
    const onDesktopInput = bridge.onDesktopInput ?? bridge.input?.onDesktopInput
    const removeForwarded = onDesktopInput?.((input) => {
      dispatchDesktopInput(input)
    })
    return () => {
      removeHotkey?.()
      removeDrop?.()
      removeForwarded?.()
    }
  }, [captureClipboard, enqueue, navigate])

  useEffect(() => subscribeDesktopInput((input: DesktopInput) => {
    if (input.type === 'focus-composer') {
      // A click on the inline pet should stay on `/now`; clicking the resident
      // pet already arrives through openMain with this same route hint.
      navigate('/now', { replace: true, state: { focusComposer: true } })
      return
    }
    if (input.type === 'clipboard') {
      enqueue(() => captureClipboard(input.source))
      return
    }
    if (input.type === 'files') {
      enqueue(() => captureFiles(input.paths))
    }
  }), [captureClipboard, captureFiles, enqueue, navigate])

  return null
}

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || '文件'
}

function rawTypeForPath(path: string): 'image' | 'file' {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const extension = normalized.slice(normalized.lastIndexOf('.'))
  return IMAGE_EXTENSIONS.has(extension)
    ? 'image'
    : 'file'
}

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.heic', '.heif',
])

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function resetStatusSoon(
  setStatus: (status: 'idle' | 'receiving' | 'processing' | 'done' | 'error' | 'focus', meta?: { message?: string }) => void,
  status: 'done' | 'error',
): void {
  window.setTimeout(() => setStatus(status === 'error' ? 'error' : 'idle'), 1600)
}
