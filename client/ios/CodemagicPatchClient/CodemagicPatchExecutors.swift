import Foundation

let codemagicPatchIoQueue = DispatchQueue(label: "io.codemagic.patch.io")
let codemagicPatchNetworkQueue = DispatchQueue(label: "io.codemagic.patch.network")
// Metrics delivery gets its own queue so that a stalled upload never delays the
// manifest fetches and downloads queued on the network queue.
let codemagicPatchMetricsQueue = DispatchQueue(label: "io.codemagic.patch.metrics")

private let codemagicPatchIoQueueKey = DispatchSpecificKey<Void>()
private let configureCodemagicPatchIoQueue: Void = {
  codemagicPatchIoQueue.setSpecific(key: codemagicPatchIoQueueKey, value: ())
}()

func codemagicPatchIoQueueSync<T>(_ work: () throws -> T) rethrows -> T {
  _ = configureCodemagicPatchIoQueue
  if DispatchQueue.getSpecific(key: codemagicPatchIoQueueKey) != nil {
    return try work()
  }
  return try codemagicPatchIoQueue.sync(execute: work)
}
