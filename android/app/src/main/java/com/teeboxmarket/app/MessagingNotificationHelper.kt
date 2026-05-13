package com.teeboxmarket.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.graphics.drawable.IconCompat
import java.net.URL

/**
 * MessagingNotificationHelper — central place for building rich Android
 * notifications. Called from the Firebase Messaging service (when one is
 * added) OR from a BroadcastReceiver triggered by data-only FCM payloads.
 *
 * Public surface:
 *   - ensureChannels(ctx) — idempotent channel registration. Call once
 *     on app start (e.g. from MainActivity.onCreate or Application).
 *   - showOfferNotification(...) — MessagingStyle + Accept/Decline actions.
 *   - showPriceDropNotification(...) — BigPictureStyle with listing image.
 *   - showMessagingNotification(...) — MessagingStyle + inline reply.
 *     (Wiring of the "send reply" intent is OWNED BY THE MESSAGE AGENT.
 *      This helper exposes the builder; it does not register the receiver.)
 *
 * Channel ids MUST match `androidChannelFor(...)` in functions/lib/push.js.
 */
object MessagingNotificationHelper {

    // Notification group keys — match `threadId` from the server payload
    // so multiple notifications about the same listing/order collapse.
    private const val GROUP_KEY_PREFIX = "com.teeboxmarket.app.GROUP."

    // Channel ids (mirror functions/lib/push.js androidChannelFor).
    const val CHANNEL_OFFERS = "teebox_offers"
    const val CHANNEL_ORDERS = "teebox_orders"
    const val CHANNEL_MESSAGES = "teebox_messages"
    const val CHANNEL_PRICE_DROPS = "teebox_price_drops"
    const val CHANNEL_SAVED_SEARCHES = "teebox_saved_searches"
    const val CHANNEL_DEFAULT = "teebox_default"

    /** Inline-reply input key — read by the receiver via RemoteInput. */
    const val REPLY_INPUT_KEY = "key_reply_input"

    /** Idempotent channel creation. Safe to call every cold start. */
    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val defs = listOf(
            ChannelDef(CHANNEL_OFFERS, "Offers", NotificationManager.IMPORTANCE_HIGH,
                "Buyers offering on your listings, accepts, declines, counters."),
            ChannelDef(CHANNEL_ORDERS, "Orders", NotificationManager.IMPORTANCE_HIGH,
                "Sold notifications, shipping updates, delivery confirmations, payouts."),
            ChannelDef(CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH,
                "New messages from buyers and sellers."),
            ChannelDef(CHANNEL_PRICE_DROPS, "Price drops", NotificationManager.IMPORTANCE_DEFAULT,
                "Watchlist price drop alerts."),
            ChannelDef(CHANNEL_SAVED_SEARCHES, "Saved searches", NotificationManager.IMPORTANCE_LOW,
                "Daily digest of new matches for your saved searches."),
            ChannelDef(CHANNEL_DEFAULT, "TeeBox", NotificationManager.IMPORTANCE_DEFAULT,
                "General TeeBox updates and announcements.")
        )

        defs.forEach { def ->
            val ch = NotificationChannel(def.id, def.name, def.importance).apply {
                description = def.desc
                enableLights(true)
                lightColor = 0xFF1F4827.toInt()
            }
            nm.createNotificationChannel(ch)
        }
    }

    /**
     * MessagingStyle notification for a new offer with Accept / Decline
     * action buttons that hit a broadcast receiver. The receiver should
     * call the `acceptOffer` / `declineOffer` Cloud Functions callables.
     */
    fun showOfferNotification(
        ctx: Context,
        notificationId: Int,
        offerId: String,
        listingId: String,
        listingTitle: String,
        buyerName: String,
        amount: String,
        imageUrl: String?,
        deepLink: String
    ) {
        ensureChannels(ctx)
        val user = Person.Builder().setName("You").build()
        val buyer = Person.Builder()
            .setName(buyerName)
            .setIcon(loadIconFromUrl(imageUrl))
            .build()

        val style = NotificationCompat.MessagingStyle(user)
            .setConversationTitle("Offer on $listingTitle")
            .addMessage("Offered $$amount on $listingTitle", System.currentTimeMillis(), buyer)

        val tapIntent = mainActivityIntent(ctx, deepLink, offerId)
        val tapPI = PendingIntent.getActivity(
            ctx, notificationId, tapIntent, pendingIntentFlags()
        )

        val acceptPI = broadcastPI(ctx, "com.teeboxmarket.app.ACCEPT_OFFER", offerId, notificationId)
        val declinePI = broadcastPI(ctx, "com.teeboxmarket.app.DECLINE_OFFER", offerId, notificationId)

        val groupKey = GROUP_KEY_PREFIX + "listing-$listingId"
        val n = NotificationCompat.Builder(ctx, CHANNEL_OFFERS)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setStyle(style)
            .setContentIntent(tapPI)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_SOCIAL)
            .setGroup(groupKey)
            .addAction(
                NotificationCompat.Action.Builder(
                    R.mipmap.ic_launcher, "Accept", acceptPI
                ).build()
            )
            .addAction(
                NotificationCompat.Action.Builder(
                    R.mipmap.ic_launcher, "Decline", declinePI
                ).build()
            )
            .build()

        NotificationManagerCompat.from(ctx).notify(notificationId, n)
        emitGroupSummary(ctx, groupKey, CHANNEL_OFFERS)
    }

    /** BigPictureStyle notification for a price-drop alert. */
    fun showPriceDropNotification(
        ctx: Context,
        notificationId: Int,
        listingId: String,
        listingTitle: String,
        newPrice: String,
        oldPrice: String,
        imageUrl: String?,
        deepLink: String
    ) {
        ensureChannels(ctx)
        val tapPI = PendingIntent.getActivity(
            ctx, notificationId,
            mainActivityIntent(ctx, deepLink, listingId),
            pendingIntentFlags()
        )

        val builder = NotificationCompat.Builder(ctx, CHANNEL_PRICE_DROPS)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Price drop: $listingTitle")
            .setContentText("Now $$newPrice (was $$oldPrice)")
            .setContentIntent(tapPI)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setGroup(GROUP_KEY_PREFIX + "listing-$listingId")

        val bitmap = imageUrl?.let { tryDownloadBitmap(it) }
        if (bitmap != null) {
            builder.setLargeIcon(bitmap)
                .setStyle(
                    NotificationCompat.BigPictureStyle()
                        .bigPicture(bitmap)
                        .bigLargeIcon(null as android.graphics.Bitmap?)
                )
        }

        NotificationManagerCompat.from(ctx).notify(notificationId, builder.build())
    }

    /**
     * MessagingStyle + inline reply for the messages category.
     *
     * NOTE: actual reply-submission is owned by the message-agent's PR.
     * This builder exposes the action; that PR will register the matching
     * BroadcastReceiver to read RemoteInput.getResultsFromIntent(...) and
     * forward to the `sendMessage` Cloud Function.
     */
    fun showMessagingNotification(
        ctx: Context,
        notificationId: Int,
        conversationId: String,
        senderName: String,
        senderAvatarUrl: String?,
        messagePreview: String,
        deepLink: String
    ) {
        ensureChannels(ctx)
        val user = Person.Builder().setName("You").build()
        val sender = Person.Builder()
            .setName(senderName)
            .setIcon(loadIconFromUrl(senderAvatarUrl))
            .build()

        val style = NotificationCompat.MessagingStyle(user)
            .setConversationTitle(senderName)
            .addMessage(messagePreview, System.currentTimeMillis(), sender)

        val tapPI = PendingIntent.getActivity(
            ctx, notificationId,
            mainActivityIntent(ctx, deepLink, conversationId),
            pendingIntentFlags()
        )

        // Inline reply RemoteInput.
        val remoteInput = RemoteInput.Builder(REPLY_INPUT_KEY)
            .setLabel("Reply…")
            .build()

        val replyIntent = Intent("com.teeboxmarket.app.REPLY_MESSAGE").apply {
            setPackage(ctx.packageName)
            putExtra("conversationId", conversationId)
            putExtra("notificationId", notificationId)
        }
        val replyPI = PendingIntent.getBroadcast(
            ctx, notificationId, replyIntent, pendingIntentFlags()
        )
        val replyAction = NotificationCompat.Action.Builder(
            R.mipmap.ic_launcher, "Reply", replyPI
        )
            .addRemoteInput(remoteInput)
            .setAllowGeneratedReplies(true)
            .build()

        val groupKey = GROUP_KEY_PREFIX + "conv-$conversationId"
        val n = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setStyle(style)
            .setContentIntent(tapPI)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .addAction(replyAction)
            .setGroup(groupKey)
            .build()

        NotificationManagerCompat.from(ctx).notify(notificationId, n)
        emitGroupSummary(ctx, groupKey, CHANNEL_MESSAGES)
    }

    // ── private helpers ────────────────────────────────────────────

    private data class ChannelDef(
        val id: String,
        val name: String,
        val importance: Int,
        val desc: String
    )

    private fun pendingIntentFlags(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else
            PendingIntent.FLAG_UPDATE_CURRENT
    }

    /** Build the Intent that launches the Capacitor activity with a deep
     *  link in extras — MainActivity will forward to the WebView via the
     *  Capacitor bridge so JavaScript's app-resume handler can route. */
    private fun mainActivityIntent(ctx: Context, deepLink: String, entityId: String): Intent {
        return Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            data = Uri.parse(deepLink)
            putExtra("teebox_deep_link", deepLink)
            putExtra("teebox_entity_id", entityId)
        }
    }

    private fun broadcastPI(ctx: Context, action: String, id: String, reqCode: Int): PendingIntent {
        val intent = Intent(action).apply {
            setPackage(ctx.packageName)
            putExtra("offerId", id)
            putExtra("notificationId", reqCode)
        }
        return PendingIntent.getBroadcast(ctx, reqCode, intent, pendingIntentFlags())
    }

    /** Best-effort sync image fetch. MUST NOT be called on the main thread.
     *  Returns null on any failure; the caller silently degrades. */
    private fun tryDownloadBitmap(url: String): android.graphics.Bitmap? {
        return try {
            URL(url).openStream().use { BitmapFactory.decodeStream(it) }
        } catch (e: Exception) {
            null
        }
    }

    private fun loadIconFromUrl(url: String?): IconCompat? {
        if (url.isNullOrBlank()) return null
        val bmp = tryDownloadBitmap(url) ?: return null
        return IconCompat.createWithBitmap(bmp)
    }

    /** Emit the group-summary notification so Android collapses multiple
     *  alerts under the same threadId into one expandable stack. */
    private fun emitGroupSummary(ctx: Context, groupKey: String, channelId: String) {
        val summary = NotificationCompat.Builder(ctx, channelId)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setGroup(groupKey)
            .setGroupSummary(true)
            .setAutoCancel(true)
            .build()
        // Use groupKey.hashCode() so collisions are stable per-thread.
        NotificationManagerCompat.from(ctx).notify(groupKey.hashCode(), summary)
    }
}
