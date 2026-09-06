import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { bridge } from '../bridge.ts'
import { isPetStatus, type PetStatus, type PetStatusMeta } from './state-machine.ts'

export type PetContextValue = {
  status: PetStatus
  meta: PetStatusMeta
  setStatus: (status: PetStatus, meta?: PetStatusMeta) => void
}

const PetContext = createContext<PetContextValue>({
  status: 'idle',
  meta: {},
  setStatus: () => {},
})

/**
 * One status source for the inline and resident presentations in this
 * renderer. Native commands are replayed through preload; local calls update
 * the inline pet immediately and then forward the same state to Electron.
 */
export function PetStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatusState] = useState<PetStatus>('idle')
  const [meta, setMeta] = useState<PetStatusMeta>({})

  useEffect(() => {
    const unsubscribe = bridge.pet?.onCommand((command) => {
      if (command.type !== 'set-status' || !command.status || !isPetStatus(command.status)) return
      setStatusState(command.status)
      setMeta(command.meta ?? {})
    })
    return () => unsubscribe?.()
  }, [])

  const setStatus = useCallback((next: PetStatus, nextMeta: PetStatusMeta = {}) => {
    setStatusState(next)
    setMeta(nextMeta)
    // `pet.setStatus` and the flat alias point at the same IPC implementation
    // in Electron. Prefer the grouped method when available, while retaining
    // compatibility with the first preload contract and browser mock.
    if (bridge.pet?.setStatus) bridge.pet.setStatus(next, nextMeta)
    else bridge.setPetStatus?.(next, nextMeta)
  }, [])

  const value = useMemo(() => ({ status, meta, setStatus }), [meta, setStatus, status])
  return <PetContext.Provider value={value}>{children}</PetContext.Provider>
}

export function usePetStatus(): PetContextValue {
  return useContext(PetContext)
}
