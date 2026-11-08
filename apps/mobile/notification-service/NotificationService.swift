import Intents
import UserNotifications

/// Shows each Apollo notification as a message from the bot: the bot's avatar large, with
/// Apollo's icon small in the corner (iOS "communication notifications").
///
/// The push carries the bot's avatar as `{ shape, color }` (Expo puts the push's `data`
/// under `body`). The picture is in the app group shared with the app, which downloads the
/// images of its bots' avatars from Apollo (the desktop app draws them). Anything missing,
/// and the notification shows as it came.
final class NotificationService: UNNotificationServiceExtension {
  /// Shared with the app (src/avatars.ts).
  static let appGroup = "group.dev.ocx64.apollo.mobile"
  private var handler: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    original = request.content
    let content = request.content
    let data = (content.userInfo["body"] as? [String: Any])
      ?? (content.userInfo as? [String: Any]) ?? [:]
    guard
      let avatar = data["avatar"] as? [String: Any],
      let shape = avatar["shape"] as? String,
      let color = avatar["color"] as? String,
      let shared = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup),
      let picture = try? Data(contentsOf: shared.appendingPathComponent("avatars/\(shape)-\(color).png"))
    else {
      return contentHandler(content)
    }
    let botId = (data["botId"] as? String) ?? "\(shape)-\(color)"
    let image = INImage(imageData: picture)
    let sender = INPerson(
      personHandle: INPersonHandle(value: botId, type: .unknown),
      nameComponents: nil,
      displayName: content.title,
      image: image,
      contactIdentifier: nil,
      customIdentifier: botId
    )
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: content.body,
      speakableGroupName: nil,
      conversationIdentifier: (data["sessionId"] as? String) ?? botId,
      serviceName: nil,
      sender: sender,
      attachments: nil
    )
    intent.setImage(image, forParameterNamed: \.sender)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { _ in
      contentHandler((try? content.updating(from: intent)) ?? content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let handler, let original { handler(original) }
  }
}
