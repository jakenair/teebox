import UIKit
import Capacitor

// Registers the app's own (non-npm) Capacitor plugins. Main.storyboard points its
// view controller at this class instead of CAPBridgeViewController. Plugins that
// come from node_modules are still auto-registered via packageClassList; local
// ones must be added here (cap sync would drop them from that list).
class TeeBoxViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MetaEventsPlugin())
    }
}
