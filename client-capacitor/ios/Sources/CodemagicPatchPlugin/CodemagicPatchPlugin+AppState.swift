import Foundation
import UIKit

/// App-state signal for JS: its lifecycle activation (`ON_NEXT_RESUME`/`ON_NEXT_SUSPEND`)
/// and `start()`'s `ON_APP_RESUME` re-check both run on it — see
/// specs/adr/0013-native-app-state-events.md. A separate file for the same reason as
/// `CodemagicPatchPlugin+NetworkError.swift`/`+Signature.swift`: SwiftLint's
/// `type_body_length`.
extension CodemagicPatchPlugin {
    static let appStateChangeEvent = "CodemagicPatchAppStateChange"

    /// React Native's own `AppState` value names, emitted on the same `UIApplication`
    /// notifications RN's iOS `AppState` maps them from, so upstream's JS lifecycle state
    /// machine ports unchanged. Not retained: JS starts from `active`, which a cold
    /// start's first `didBecomeActive` merely confirms.
    private static let appStateNotifications: [(Notification.Name, String)] = [
        (UIApplication.didBecomeActiveNotification, "active"),
        (UIApplication.willResignActiveNotification, "inactive"),
        (UIApplication.didEnterBackgroundNotification, "background")
    ]

    /// Called once from `load()`. The observers live as long as the plugin, which lives
    /// as long as the bridge.
    func observeAppStateChanges() {
        for (name, appState) in Self.appStateNotifications {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.notifyListeners(Self.appStateChangeEvent, data: ["appState": appState])
            }
        }
    }
}
