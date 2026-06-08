import UIKit
import Capacitor
import FirebaseCore
import FirebaseAuth
import FirebaseCrashlytics
import FirebaseAppCheck
import FirebaseMessaging

// HIGH-1 Phase 1 — App Check provider factory. Uses App Attest on iOS 14+
// (project's deployment target floor) and falls back to DeviceCheck just in
// case a stray older device gets through. MUST be installed BEFORE
// FirebaseApp.configure() so the first Firebase request carries a token.
// Phase 1 is monitor-only — server-side enforcement flips on in Phase 2 after
// 24-48h of dashboard data confirms tokens are flowing on legit clients.
class AppAttestProviderFactory: NSObject, AppCheckProviderFactory {
    func createProvider(with app: FirebaseApp) -> AppCheckProvider? {
        if #available(iOS 14.0, *) {
            return AppAttestProvider(app: app)
        }
        return DeviceCheckProvider(app: app)
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Install the App Check provider factory BEFORE FirebaseApp.configure()
        // so the first Firebase SDK call (Auth, Firestore, Functions) attaches
        // a valid App Check token.
        AppCheck.setAppCheckProviderFactory(AppAttestProviderFactory())
        FirebaseApp.configure()
        // Crashlytics auto-initializes once FirebaseApp.configure() runs and
        // the pod is linked, but calling setCrashlyticsCollectionEnabled
        // explicitly (a) confirms wiring at compile time and (b) overrides
        // any future opt-out we might wire into user prefs. See PR 4 in
        // BUG_TRIAGE_2026_05_17.md — Bug 5 prerequisite.
        Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(true)
        DispatchQueue.main.async {
            application.registerForRemoteNotifications()
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Firebase Auth needs first crack at the URL (reCAPTCHA fallback flow can
        // bounce through Safari → back here).
        if Auth.auth().canHandle(url) {
            return true
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        // Match the build's aps-environment. Debug builds use the sandbox
        // APNs servers; Release / TestFlight / App Store use prod. Picking
        // the wrong type silently routes the auth-silent-push to a server
        // that will never deliver it, which is exactly the
        // "phone code never arrives" symptom we were chasing.
        #if DEBUG
        Auth.auth().setAPNSToken(deviceToken, type: .sandbox)
        #else
        Auth.auth().setAPNSToken(deviceToken, type: .prod)
        #endif
        // APNs -> FCM bridge. FirebaseAppDelegateProxyEnabled is false (Info.plist),
        // so the SDK does NOT auto-forward the APNs token. Hand it to Messaging
        // explicitly so it can mint the FCM registration token the server's
        // sendEachForMulticast targets — without this the client yields raw APNs
        // tokens and every push silently fails to deliver.
        Messaging.messaging().apnsToken = deviceToken
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification notification: [AnyHashable : Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        if Auth.auth().canHandleNotification(notification) {
            completionHandler(.noData)
            return
        }
        completionHandler(.newData)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
