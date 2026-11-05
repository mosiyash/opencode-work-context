export const createTuiFocusTracker = ({ renderer, onFocus, onActivity, onBlur } = {}) => {
  let state = "unknown";
  const handleFocus = () => {
    state = "focused";
    try { onActivity?.(); } catch {}
    try { onFocus?.(); } catch {}
  };
  const handleKeypress = () => {
    state = "focused";
    try { onActivity?.(); } catch {}
  };
  const handleBlur = () => {
    state = "blurred";
    try { onBlur?.(); } catch {}
  };
  renderer?.on?.("focus", handleFocus);
  renderer?.on?.("blur", handleBlur);
  renderer?.keyInput?.on?.("keypress", handleKeypress);
  return {
    state: () => state,
    isFocused: () => state !== "blurred",
    dispose: () => {
      renderer?.off?.("focus", handleFocus);
      renderer?.off?.("blur", handleBlur);
      renderer?.keyInput?.off?.("keypress", handleKeypress);
    },
  };
};
