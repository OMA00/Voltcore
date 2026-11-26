// ============================================================
// Provider-neutral pod operations.
//
// The RunPod and Vast.ai modules return different shapes: getRunPodStatus returns an
// object ({ status: 'RUNNING' }) and terminateRunPod returns { success }, while the
// Vast.ai functions return a string and a boolean. Callers compared RunPod's object to
// the string 'RUNNING', which never matched, so RunPod pods were never terminated at
// the end of a job and the poller never saw them exit. Everything outside src/providers
// now goes through these functions and gets one shape back.
// ============================================================
import { getRunPodStatus, terminateRunPod, listRunPodPods } from './runpod.js'
import { getVastaiStatus, terminateVastai, listVastaiInstances } from './vastai.js'

/** The pod name every VoltCore job uses, so a pod can be found even if its id was never saved. */
export const podNameFor = jobId => `voltcore-${jobId}`

/** @returns {'running'|'starting'|'exited'|'unknown'} */
export async function getPodState(providerName, podId) {
  if (providerName === 'runpod') {
    const s = await getRunPodStatus(podId)
    const status = String(s?.status || '').toUpperCase()
    if (status === 'RUNNING') return 'running'
    if (['EXITED', 'TERMINATED'].includes(status)) return 'exited'
    if (['CREATED', 'RESTARTING'].includes(status)) return 'starting'
    return 'unknown'
  }
  if (providerName === 'vastai') {
    const s = String((await getVastaiStatus(podId)) || '').toLowerCase()
    if (s === 'running') return 'running'
    if (['exited', 'stopped', 'offline'].includes(s)) return 'exited'
    if (['loading', 'created', 'scheduling'].includes(s)) return 'starting'
    return 'unknown'
  }
  return 'unknown'
}

/** @returns {Promise<boolean>} true only when the pod is gone (terminated or already absent). */
export async function terminatePod(providerName, podId) {
  try {
    if (providerName === 'runpod') return (await terminateRunPod(podId))?.success === true
    if (providerName === 'vastai') return (await terminateVastai(podId)) === true
  } catch (err) {
    console.error(`Terminate ${providerName}/${podId} threw: ${err.message}`)
  }
  return false
}

/**
 * Find pods by name on every provider. Used by the sweep to catch a pod created just
 * before a crash, before its id was saved.
 * @returns {Promise<Array<{ providerName: string, podId: string }>>}
 */
export async function findPodsByName(name) {
  const found = []
  for (const [providerName, list] of [['runpod', listRunPodPods], ['vastai', listVastaiInstances]]) {
    try {
      for (const p of await list()) if (p.name === name) found.push({ providerName, podId: String(p.id) })
    } catch (err) {
      console.error(`Listing ${providerName} pods failed: ${err.message}`)
      throw err // a failed listing must not be read as "no orphan"
    }
  }
  return found
}
