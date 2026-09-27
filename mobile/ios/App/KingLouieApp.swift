import SwiftUI
import UIKit
import UserNotifications

/// APNs is registered only when the build names a topic (Config/App.xcconfig);
/// without it the app long-polls while it is open.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var onToken: ((String) -> Void)? {
        didSet { if let token, let onToken { onToken(token) } }
    }
    /// (kind, id): an approval's request id, or the id a pairing or alert push names.
    var onOpen: ((String, String) -> Void)?
    /// A token that arrived before the app's scene hooked up onToken.
    private var token: String?

    static var pushConfigured: Bool {
        !((Bundle.main.object(forInfoDictionaryKey: "KLApnsTopic") as? String) ?? "").isEmpty
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        guard Self.pushConfigured else { return true }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            if granted { DispatchQueue.main.async { application.registerForRemoteNotifications() } }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        token = hex
        onToken?(hex)
    }

    /// The push is { aps, kl: { rid, k } }; a missing k means approval.
    /// Approval, pairing and alert pushes are handled; the app fetches and
    /// verifies what they name itself.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let kl = response.notification.request.content.userInfo["kl"] as? [String: Any]
        guard let id = kl?["rid"] as? String else { return }
        let kind = (kl?["k"] as? String) ?? "approval"
        guard ["approval", "pairing", "alert"].contains(kind) else { return }
        await MainActor.run { onOpen?(kind, id) }
    }
}

@main
struct KingLouieApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .onAppear {
                    delegate.onToken = { token in Task { await model.registerPushToken(token) } }
                    delegate.onOpen = { kind, id in Task { await model.openPushed(kind: kind, id: id) } }
                }
        }
        // Only leaving for the background stops the poll: a Face ID prompt
        // makes the scene inactive, and stopping then would cancel the very
        // unlock it is waiting for.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model.resumePolling()
            case .background: model.stopPolling()
            default: break
            }
        }
    }
}
