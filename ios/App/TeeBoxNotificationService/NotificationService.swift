//
//  NotificationService.swift
//  TeeBoxNotificationService
//
//  iOS Notification Service Extension. APNs delivers the payload to this
//  extension FIRST (because we send `mutable-content: 1`) and gives us
//  ~30 seconds to mutate the notification before it's displayed.
//
//  We use that window to:
//    1. Download `imageUrl` from the custom payload (seller avatar OR
//       listing thumbnail) into the shared file container.
//    2. Attach it as a `UNNotificationAttachment` so the banner shows
//       a rich image preview and the long-press preview shows a card.
//    3. Apply the proper category identifier (TEEBOX_OFFER, etc) so the
//       action buttons (Accept / Decline on offers, View on price drops)
//       are wired up by the AppDelegate-registered UNNotificationCategory.
//
//  If the download fails (no network, bad URL, timeout), we fall back to
//  the plain text notification — the user still sees the alert, just no
//  picture.
//
//  TARGET SETUP (see PUSH_TEST_PLAN.md for full steps):
//    - Bundle id: com.teeboxmarket.app.NotificationService
//    - Deployment target: iOS 14.0
//    - App Groups capability: group.com.teeboxmarket.app  (shared with
//      the main app so we can read pending notification state)
//    - "Push Notifications" capability is NOT required on the extension
//      itself — only on the main app target.
//

import UserNotifications
import UIKit

class NotificationService: UNNotificationServiceExtension {

    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        self.bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        guard let bestAttemptContent = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        // Pull custom keys we set server-side in lib/push.js (siblings of
        // `aps`). FCM-translated APNs payloads land under userInfo.
        let userInfo = request.content.userInfo
        let imageUrlString = (userInfo["imageUrl"] as? String) ?? ""
        let category = (userInfo["category"] as? String) ?? "TEEBOX_DEFAULT"

        // Map server "category" → APNs UNNotificationCategory identifier.
        // (Server already sets aps.category but we belt-and-suspenders it
        //  here in case a future server change drops the field.)
        bestAttemptContent.categoryIdentifier = mapCategoryIdentifier(category)

        // Group across multiple notifications about the same thing.
        if let threadId = userInfo["threadId"] as? String, !threadId.isEmpty {
            bestAttemptContent.threadIdentifier = threadId
        }

        // No image to download — finish immediately.
        guard !imageUrlString.isEmpty, let url = URL(string: imageUrlString) else {
            contentHandler(bestAttemptContent)
            return
        }

        // Download the image to a temp file in the shared container, then
        // attach. UNNotificationAttachment requires a file URL, not raw data.
        downloadImage(from: url) { localUrl in
            defer { contentHandler(bestAttemptContent) }
            guard let localUrl = localUrl else { return }
            do {
                let attachment = try UNNotificationAttachment(
                    identifier: "image",
                    url: localUrl,
                    options: [UNNotificationAttachmentOptionsThumbnailHiddenKey: false]
                )
                bestAttemptContent.attachments = [attachment]
            } catch {
                NSLog("[TeeBox NSE] attachment failed: \(error.localizedDescription)")
            }
        }
    }

    override func serviceExtensionTimeWillExpire() {
        // We had ~30s and ran out. Deliver whatever we have so far so the
        // user still gets a notification — just maybe without the image.
        if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }

    /// Download a remote image to a local file. Uses URLSessionDownloadTask
    /// because UNNotificationAttachment needs a file:// url. We move the
    /// downloaded temp file into our extension's temp directory with a
    /// stable extension so iOS detects the MIME type correctly.
    private func downloadImage(from url: URL, completion: @escaping (URL?) -> Void) {
        let task = URLSession.shared.downloadTask(with: url) { (tempUrl, response, error) in
            guard let tempUrl = tempUrl, error == nil else {
                completion(nil)
                return
            }
            let ext: String = {
                let mime = response?.mimeType ?? ""
                if mime.contains("png") { return "png" }
                if mime.contains("gif") { return "gif" }
                if mime.contains("webp") { return "webp" }
                return "jpg"
            }()
            let dest = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(ext)
            do {
                try FileManager.default.moveItem(at: tempUrl, to: dest)
                completion(dest)
            } catch {
                NSLog("[TeeBox NSE] move failed: \(error.localizedDescription)")
                completion(nil)
            }
        }
        task.resume()
    }

    /// Server categories → registered UNNotificationCategory identifiers.
    /// The AppDelegate registers these with action buttons. Keep in sync
    /// with functions/lib/push.js apnsCategoryFor().
    private func mapCategoryIdentifier(_ serverCategory: String) -> String {
        switch serverCategory {
        case "offers": return "TEEBOX_OFFER"
        case "orders": return "TEEBOX_ORDER"
        case "messages": return "TEEBOX_MESSAGE"
        case "priceDrops": return "TEEBOX_PRICE_DROP"
        case "savedSearches": return "TEEBOX_SAVED_SEARCH"
        default: return serverCategory.hasPrefix("TEEBOX_") ? serverCategory : "TEEBOX_DEFAULT"
        }
    }
}
