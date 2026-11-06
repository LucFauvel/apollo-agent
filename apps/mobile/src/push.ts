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

/** Whether this phone gets notifications, and why not; shown on the home screen. */
export type PushStatus =
  | { state: "checking" }
  | { state: "on" }
  | { state: "denied" }
  | { state: "error"; message: string };
let pushStatus: PushStatus = { state: "checking" };
const pushListeners = new Set<(s: PushStatus) => void>();
const setPushStatus = (next: PushStatus) => {
  pushStatus = next;
  pushListeners.forEach((l) => l(next));
};
export const currentPushStatus = () => pushStatus;
export const subscribePushStatus = (listener: (s: PushStatus) => void) => {
  pushListeners.add(listener);
  return () => void pushListeners.delete(listener);
};

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
  setPushStatus({ state: "checking" });
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Apollo",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return setPushStatus({ state: "denied" });
    const id = projectId();
    if (!id) throw new Error("this build has no EAS project id");
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    const response = await fetch(`${pairing.server}/api/push/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pairing.token}` },
      body: JSON.stringify({ token, platform: Platform.OS === "ios" ? "ios" : "android" }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Apollo refused the registration (${response.status})`);
    }
    await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
    setPushStatus({ state: "on" });
  } catch (error) {
    setPushStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
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

/** Asks Apollo to send a test notification to this phone (and the computer). */
export const sendTestNotification = async (pairing: Pairing) => {
  const response = await fetch(`${pairing.server}/api/notifications/test`, {
    method: "POST",
    headers: { authorization: `Bearer ${pairing.token}` },
  });
  if (!response.ok) throw new Error(`Apollo refused the test (${response.status})`);
};

/** The session a tapped notification points to. */
export const sessionOf = (response: Notifications.NotificationResponse | null | undefined): SessionId | null =>
  ((response?.notification.request.content.data as { sessionId?: string } | undefined)?.sessionId as SessionId | undefined) ?? null;
