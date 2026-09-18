import { useEffect, useState } from 'react'
import {
  type FutureAILimits,
  currentLimits,
  statusListeners,
} from './futureAiLimits.js'

export function useFutureAiLimits(): FutureAILimits {
  const [limits, setLimits] = useState<FutureAILimits>({ ...currentLimits })

  useEffect(() => {
    const listener = (newLimits: FutureAILimits) => {
      setLimits({ ...newLimits })
    }
    statusListeners.add(listener)

    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return limits
}
