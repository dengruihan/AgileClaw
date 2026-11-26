import Foundation
import OpenClawKit
import UserNotifications
import WebKit

enum DashboardNotificationsRequest: String {
    case status
    case requestPermission = "request-permission"
    case sendTest = "send-test"
    case backgroundSessionCompleted = "background-session-completed"
}

struct DashboardBackgroundSessionCompletion {
    // Copy bounds shared with background-session-notice.ts; unusable text keeps the generic copy.
    static let titleLimit = 120
    static let bodyLimit = 240

    let runId: String
    let path: String
    let search: String?
    /// UI-composed session title and localized status body; nil means the UI sent none.
    let title: String?
    let body: String?

    init?(body payload: Any) {
        guard let payload = payload as? [String: Any],
              let runId = payload["runId"] as? String, !runId.isEmpty, runId.count <= 128,
              let path = payload["path"] as? String, path.count <= 4096,
              path.hasPrefix("/chat/"), DashboardRouteMap.isValidSameAppPath(path)
        else { return nil }
        let search = payload["search"] as? String
        if let search {
            guard search.count <= 2048, DashboardRouteMap.isValidSameAppSearch(search) else { return nil }
        } else if payload["search"] != nil {
            return nil
        }
        self.runId = runId
        self.path = path
        self.search = search
        self.title = Self.notificationText(payload["title"], limit: Self.titleLimit)
        self.body = Self.notificationText(payload["body"], limit: Self.bodyLimit)
    }

    /// Rejecting only the copy keeps the completion notification and its route.
    private static func notificationText(_ value: Any?, limit: Int) -> String? {
        guard let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed.utf16.count <= limit else { return nil }
        let rejected = CharacterSet.controlCharacters.union(.newlines)
        guard !trimmed.unicodeScalars.contains(where: { rejected.contains($0) }) else { return nil }
        return trimmed
    }
}

struct DashboardNotificationsSnapshot: Encodable, Equatable {
    let permission: String
    let test: TestNotificationOutcome?
}

extension DashboardWindowController {
    static let notificationsMessageHandlerName = "openclawNotifications"

    static func notificationsRequest(from body: Any) -> DashboardNotificationsRequest? {
        guard let payload = body as? [String: Any],
              let type = payload["type"] as? String
        else {
            return nil
        }
        return DashboardNotificationsRequest(rawValue: type)
    }

    static func notificationsPermissionLabel(for status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional:
            "granted"
        case .denied:
            "denied"
        case .notDetermined:
            "notDetermined"
        default:
            // .ephemeral is unavailable by name on macOS and cannot occur here;
            // map it and future cases to notDetermined so the UI offers the
            // permission request instead of claiming access.
            "notDetermined"
        }
    }

    func receiveNotificationsMessage(_ message: WKScriptMessage) {
        guard message.name == Self.notificationsMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              ControlUIDocumentHost.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL)
        else {
            return
        }
        guard let request = Self.notificationsRequest(from: message.body) else { return }

        switch request {
        case .status:
            Task { await self.refreshNotificationsPermission() }
        case .requestPermission:
            Task {
                _ = await PermissionManager.ensure([.notifications], interactive: true)
                await self.refreshNotificationsPermission()
            }
        case .sendTest:
            Task {
                guard self.notificationTestOutcome != .pending else { return }
                self.notificationTestOutcome = .pending
                await self.publishNotificationsStatus()
                self.notificationTestOutcome = await TestNotificationAction.send()
                await self.publishNotificationsStatus()
            }
        case .backgroundSessionCompleted:
            guard let completion = DashboardBackgroundSessionCompletion(body: message.body),
                  let open = self.onBackgroundSessionOpen,
                  let sourceRoute = DashboardManager.notificationRoute(self.currentURL)
            else { return }
            let sourceURL = self.currentURL
            let sourceAuth = self.auth
            let sourceID = self.notificationSourceID
            Task { [weak self] in
                await BackgroundSessionNotifications.shared.send(
                    title: completion.title,
                    body: completion.body,
                    identifier: "\(sourceID)-\(completion.runId)",
                    isCurrent: { [weak self] in
                        guard let self else { return false }
                        return self.window != nil && self.notificationSourceID == sourceID &&
                            self.currentURL == sourceURL && self.auth == sourceAuth
                    },
                    open: { open(completion, sourceRoute) })
            }
        }
    }

    private func refreshNotificationsPermission() async {
        guard PermissionManager.notificationCenterAvailable else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        self.notificationPermission = Self.notificationsPermissionLabel(for: settings.authorizationStatus)
        await self.publishNotificationsStatus()
    }

    private func publishNotificationsStatus() async {
        // Honest absence beats a fabricated status when the process is unbundled.
        guard PermissionManager.notificationCenterAvailable else { return }
        let snapshot = DashboardNotificationsSnapshot(
            permission: self.notificationPermission,
            test: self.notificationTestOutcome)
        guard let data = try? JSONEncoder().encode(snapshot),
              let json = String(data: data, encoding: .utf8)
        else { return }
        // Keep a global snapshot so late subscribers can read status without a bridge round-trip.
        _ = try? await self.webView.evaluateJavaScript(ControlUIDocumentHost.scopedDashboardScript(
            """
            window.__OPENCLAW_NATIVE_NOTIFICATIONS__ = \(json);
            window.dispatchEvent(new CustomEvent('openclaw:native-notifications-status', \
            {detail:window.__OPENCLAW_NATIVE_NOTIFICATIONS__}));
            """, url: self.currentURL))
    }
}
