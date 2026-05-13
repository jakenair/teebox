//
//  NotificationViewController.swift
//  TeeBoxNotificationContent
//
//  iOS Notification Content Extension — SCAFFOLD ONLY.
//
//  Renders a custom UI when the user long-presses a TeeBox notification.
//  Triggered for notifications whose category identifier matches the
//  UNNotificationCategory we register with `customNotificationContentScene`
//  on the AppDelegate side.
//
//  Future work (NOT implemented in this scaffold):
//    - Pull listingId from userInfo, fetch /listings/{id} via Cache-Control
//      shared App Group, render a full listing card with photo carousel +
//      seller avatar + price.
//    - Add quick-action buttons that hit Cloud Functions callables
//      (acceptOffer, declineOffer) without launching the main app.
//
//  TARGET SETUP:
//    - Bundle id: com.teeboxmarket.app.NotificationContent
//    - Deployment target: iOS 14.0
//    - UNNotificationExtensionCategory in Info.plist matches the server
//      categories (TEEBOX_OFFER, TEEBOX_ORDER, TEEBOX_PRICE_DROP).
//

import UIKit
import UserNotifications
import UserNotificationsUI

class NotificationViewController: UIViewController, UNNotificationContentExtension {

    @IBOutlet weak var titleLabel: UILabel?
    @IBOutlet weak var bodyLabel: UILabel?
    @IBOutlet weak var imageView: UIImageView?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.96, green: 0.95, blue: 0.91, alpha: 1.0)
    }

    func didReceive(_ notification: UNNotification) {
        let content = notification.request.content
        titleLabel?.text = content.title
        bodyLabel?.text = content.body

        // Load the attached image from the Notification Service Extension.
        if let attachment = content.attachments.first,
           attachment.url.startAccessingSecurityScopedResource() {
            defer { attachment.url.stopAccessingSecurityScopedResource() }
            if let data = try? Data(contentsOf: attachment.url) {
                imageView?.image = UIImage(data: data)
            }
        }
    }
}
