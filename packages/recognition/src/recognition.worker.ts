/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse } from './protocol'
import { RecognitionWorkerHost } from './worker-host'

// Entry point of the recognition Web Worker (grouping + shapes + handwriting).
const host = new RecognitionWorkerHost((msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg))
self.addEventListener('message', (e: MessageEvent<WorkerRequest>) => {
  void host.handle(e.data)
})
