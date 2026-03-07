/**
 * Stub: no-op Statsig for NexusCode CLI (no analytics).
 */
import React from 'react'
import { memoize } from 'lodash-es'

const gateValues: Record<string, boolean> = {}

export const initializeStatsig = memoize(
  async (): Promise<null> => {
    return null
  },
)

export function logEvent(
  _eventName: string,
  _metadata: { [key: string]: string | undefined },
): void {
  // no-op
}

export const checkGate = memoize(async (_gateName: string): Promise<boolean> => {
  return false
})

export const useStatsigGate = (gateName: string, defaultValue = false) => {
  const [gateValue] = React.useState(defaultValue)
  return gateValue
}

export function getGateValues(): Record<string, boolean> {
  return { ...gateValues }
}

export const getExperimentValue = memoize(
  async <T>(_experimentName: string, defaultValue: T): Promise<T> => {
    return defaultValue
  },
)

export const getDynamicConfig = async <T>(
  _configName: string,
  defaultValue: T,
): Promise<T> => {
  return defaultValue
}
