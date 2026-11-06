import type { SessionId } from "@apollo/contracts";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { Pairing } from "./connection.ts";

/**
 * Push notifications from Apollo (a turn finished, an approval, a question, a secret).
 * The phone registers its Expo push token with the server it is paired with; the
 * server sends through Expo's push service.
 */

const PUSH_TOKEN_KEY = "apollo.pushToken";

/** The conversation on screen: its notifications are not shown while the app is open. */
let viewing: SessionId | null = null;
export const setViewingSession = (id: SessionId | null) => {
  viewing = id;
};

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const sessionId = (notification.request.content.data as { sessionId?: string } | undefined)?.sessionId;
    const show = sessionId === undefined || sessionId !== viewing;
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
  },
});

const projectId = (): string | undefined =>
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;

/** Asks for permission (once) and registers this phone with the server. Never throws. */
export const registerForPush = async (pairing: Pairing): Promise<void> => {
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Apollo",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: projectId() });
    const response = await fetch(`${pairing.server}/api/push/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pairing.token}` },
      body: JSON.stringify({ token, platform: Platform.OS === "ios" ? "ios" : "android" }),
    });
    if (response.ok) await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
  } catch (error) {
    console.warn("Push registration failed", error);
  }
};

/** Stops notifications to this phone (before unpairing). Never throws. */
export const unregisterPush = async (pairing: Pairing): Promise<void> => {
  try {
    const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
    if (!token) return;
    await fetch(`${pairing.server}/api/push/unregister`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pairing.token}` },
      body: JSON.stringify({ token }),
    });
    await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
  } catch {
    // Unpairing goes on: the server drops tokens of revoked or expired phones anyway.
  }
};

/** The session a tapped notification points to. */
export const sessionOf = (response: Notifications.NotificationResponse | null | undefined): SessionId | null =>
  ((response?.notification.request.content.data as { sessionId?: string } | undefined)?.sessionId as SessionId | undefined) ?? null;
