/**
 * Global error handler that surfaces unhandled errors visually.
 * Import this once per view (e.g. in the DOMContentLoaded handler).
 *
 * Shows a small toast at the bottom-right of the screen when an
 * unhandled error or promise rejection occurs.
 */

let toastContainer: HTMLElement | null = null;

function ensureToastContainer(): HTMLElement {
  if (toastContainer) {
    return toastContainer;
  }
  toastContainer = document.createElement("div");
  toastContainer.id = "oa-error-toasts";
  toastContainer.style.cssText = `
    position: fixed;
    bottom: 12px;
    right: 12px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 420px;
    pointer-events: none;
  `;
  document.body.appendChild(toastContainer);
  return toastContainer;
}

function showErrorToast(message: string) {
  const container = ensureToastContainer();

  const toast = document.createElement("div");
  toast.style.cssText = `
    background: rgba(248, 81, 73, 0.95);
    color: #fff;
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    pointer-events: auto;
    cursor: pointer;
    animation: oa-toast-in 0.2s ease;
    max-height: 120px;
    overflow: auto;
    word-break: break-word;
  `;
  toast.textContent = message;
  toast.addEventListener("click", () => toast.remove());

  container.appendChild(toast);

  // Auto-dismiss after 8 seconds
  setTimeout(() => {
    toast.style.transition = "opacity 0.3s";
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 8000);
}

export function initGlobalErrorHandler() {
  // Inject animation keyframe
  if (!document.getElementById("oa-toast-styles")) {
    const style = document.createElement("style");
    style.id = "oa-toast-styles";
    style.textContent = `
      @keyframes oa-toast-in {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  window.addEventListener("error", (event) => {
    const msg = event.message || "Unknown error";
    console.error("[Machinen] Uncaught error:", event.error || msg);
    showErrorToast(`Error: ${msg}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "Unhandled promise rejection";
    console.error("[Machinen] Unhandled rejection:", reason);
    showErrorToast(`Error: ${msg}`);
  });
}
