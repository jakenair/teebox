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
        // Push fix (2026-07-21): receive FCM registration-token mints/refreshes
        // (didReceiveRegistrationToken below). Without a MessagingDelegate the
        // minted FCM token was never retrieved — the Capacitor plugin fell back
        // to the raw APNs hex token, which the server's FCM multicast rejects,
        // so no iOS push ever delivered.
        Messaging.messaging().delegate = self
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
        // Hand the Capacitor push plugin the FCM REGISTRATION token (String),
        // never the raw APNs Data. The plugin's registration event forwards
        // whatever object arrives on this NotificationCenter name — a Data
        // posts as an APNs hex string (the pre-fix bug), a String passes
        // through verbatim. JS stores it at users/{uid}/fcmTokens/{token},
        // which sendEachForMulticast targets — so it MUST be the FCM token.
        Messaging.messaging().token { token, error in
            if let token = token {
                NotificationCenter.default.post(
                    name: .capacitorDidRegisterForRemoteNotifications, object: token)
            } else if let error = error {
                NotificationCenter.default.post(
                    name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
            }
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
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

// Push fix (2026-07-21): FCM token refresh path. Fires when Messaging mints
// or rotates the registration token (first mint after apnsToken is set, app
// restore on a new device, periodic rotation). Posting the String keeps the
// stored fcmTokens doc current without waiting for the next register() call.
extension AppDelegate: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken = fcmToken else { return }
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications, object: fcmToken)
    }
}
