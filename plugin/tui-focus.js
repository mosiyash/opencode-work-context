export const createTuiFocusTracker = ({ renderer, onFocus } = {}) => {
  let state = "unknown";
  const handleFocus = () => {
    state = "focused";
    try { onFocus?.(); } catch {}
  };
  const handleBlur = () => { state = "blurred"; };
  renderer?.on?.("focus", handleFocus);
  renderer?.on?.("blur", handleBlur);
  return {
    state: () => state,
    isFocused: () => state !== "blurred",
    dispose: () => {
      renderer?.off?.("focus", handleFocus);
      renderer?.off?.("blur", handleBlur);
    },
  };
};
