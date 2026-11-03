import Foundation
import Capacitor
import FBSDKCoreKit

// MetaEvents — 2.6.2 (125). Lets the bundled privacy page's "Do Not Sell or Share"
// switch turn the Meta SDK's automatic App Events (App Install / App Launch) off
// inside the app, mirroring what the same switch does to the Meta Pixel on the web.
// The choice is persisted in UserDefaults so AppDelegate can apply it BEFORE the
// SDK initialises on the next cold launch (the launch event fires at init).
//   setEnabled({ enabled: Bool })  → applies live + persists
//   getEnabled()                   → { enabled: Bool }
@objc(MetaEventsPlugin)
public class MetaEventsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MetaEventsPlugin"
    public let jsName = "MetaEvents"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getEnabled", returnType: CAPPluginReturnPromise)
    ]
    static let defaultsKey = "tb_meta_events_off"

    /// true when the user has opted out (read by AppDelegate before SDK init).
    static var optedOut: Bool { UserDefaults.standard.bool(forKey: defaultsKey) }

    @objc func setEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? true
        UserDefaults.standard.set(!enabled, forKey: MetaEventsPlugin.defaultsKey)
        DispatchQueue.main.async {
            FBSDKCoreKit.Settings.shared.isAutoLogAppEventsEnabled = enabled
            // Advertiser-ID collection stays OFF regardless (no ATT prompt in this app).
            FBSDKCoreKit.Settings.shared.isAdvertiserIDCollectionEnabled = false
            call.resolve(["enabled": enabled])
        }
    }

    @objc func getEnabled(_ call: CAPPluginCall) {
        call.resolve(["enabled": !MetaEventsPlugin.optedOut])
    }
}
