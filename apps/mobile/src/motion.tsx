import { type ReactNode, useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Easing,
  type GestureResponderEvent,
  Keyboard,
  LayoutAnimation,
  PanResponder,
  type PanResponderGestureState,
  Platform,
  UIManager,
  useWindowDimensions,
} from "react-native";

if (Platform.OS === "android")
  UIManager.setLayoutAnimationEnabledExperimental?.(true);

/** Animates the next layout change (a section opening, a message arriving). */
export const animateLayout = (duration = 220) =>
  LayoutAnimation.configureNext({
    duration,
    create: { type: "easeInEaseOut", property: "opacity" },
    update: { type: "easeInEaseOut" },
    delete: { type: "easeInEaseOut", property: "opacity" },
  });

/** A screen sliding and fading in when it mounts. */
export function SlideIn({
  children,
  from = "right",
}: {
  children: ReactNode;
  from?: "left" | "right";
}) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress]);
  const offset = from === "right" ? 36 : -24;
  return (
    <Animated.View
      style={{
        flex: 1,
        opacity: progress,
        transform: [
          {
            translateX: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [offset, 0],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

/** Fades a row in when it first appears (unless `animate` is false when it mounts). */
export function FadeIn({
  children,
  animate = true,
}: {
  children: ReactNode;
  animate?: boolean;
}) {
  const progress = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    if (!animate) return;
    Animated.timing(progress, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);
  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [6, 0],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * A screen that slides in from the right and goes back when swiped right from the
 * left edge, like iOS navigation. Starting at the edge leaves sideways scrolling
 * (code blocks, tables) alone.
 */
export function SwipeBack({ children, onBack }: { children: ReactNode; onBack: () => void }) {
  const { width } = useWindowDimensions();
  const enter = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const back = useRef(onBack);
  back.current = onBack;

  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter]);

  const responder = useMemo(() => {
    const claims = (_: GestureResponderEvent, g: PanResponderGestureState) =>
      g.moveX - g.dx < EDGE && g.dx > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5;
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: claims,
      onMoveShouldSetPanResponder: claims,
      onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dx)),
      onPanResponderRelease: (_, g) => {
        if (g.dx > width * 0.33 || g.vx > 0.5) {
          Animated.timing(drag, { toValue: width, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(
            () => back.current(),
          );
        } else {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        }
      },
      onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(),
      onPanResponderTerminationRequest: () => false,
    });
  }, [drag, width]);

  return (
    <Animated.View
      {...responder.panHandlers}
      style={{
        flex: 1,
        opacity: Animated.multiply(enter, drag.interpolate({ inputRange: [0, width], outputRange: [1, 0.6], extrapolate: "clamp" })),
        transform: [{ translateX: Animated.add(enter.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }), drag) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

/** How far from the left edge a back swipe may start. */
const EDGE = 40;

/**
 * How much of the screen the keyboard covers, following its own animation. The bottom
 * safe-area inset is subtracted: the keyboard sits over it, and it is already padded.
 */
export function useKeyboardInset(bottomInset: number, onShow?: () => void) {
  const inset = useRef(new Animated.Value(0)).current;
  const shown = useRef(onShow);
  shown.current = onShow;
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const move = (to: number, duration: number) =>
      Animated.timing(inset, {
        toValue: to,
        duration: ios ? duration || 250 : 120,
        easing: Easing.bezier(0.17, 0.59, 0.4, 0.77), // close to the iOS keyboard curve
        useNativeDriver: false,
      }).start();
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) => {
      move(Math.max(0, e.endCoordinates.height - bottomInset), e.duration);
      shown.current?.();
    });
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", (e) => move(0, e.duration));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [inset, bottomInset]);
  return inset;
}
