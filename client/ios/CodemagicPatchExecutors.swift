import Foundation

let codemagicPatchIoQueue = DispatchQueue(label: "io.codemagic.patch.io")
let codemagicPatchNetworkQueue = DispatchQueue(label: "io.codemagic.patch.network")
let codemagicPatchMetricsLock = NSRecursiveLock()

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

func withCodemagicPatchMetricsLock<T>(_ work: () throws -> T) rethrows -> T {
  codemagicPatchMetricsLock.lock()
  defer { codemagicPatchMetricsLock.unlock() }
  return try work()
}
