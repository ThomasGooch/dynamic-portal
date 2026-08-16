"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { Toast } from "@portal/protocol";

/**
 * Toasts belong to the shell, not to the screen.
 *
 * They were screen state first, and the bug that produced this file is worth
 * recording: a satellite that answers an action with `navigate` — approve an
 * order, go back to the list — unmounts the screen that raised the toast, so
 * "Order approved" flashed out of existence at the moment it became true.
 *
 * The layout persists across navigation within the portal, so state that lives
 * here survives the thing that was destroying it. That is also the honest
 * model: a toast reports what happened to the *portal*, and the screen it
 * happened on may well be gone by the time it is read.
 */

interface ToastContextValue {
  readonly toast: Toast | undefined;
  readonly show: (toast: Toast | undefined) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToaster(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === undefined) {
    throw new Error("useToaster must be used inside <Toaster>");
  }
  return value;
}

export function Toaster({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | undefined>(undefined);
  const show = useCallback((next: Toast | undefined) => setToast(next), []);

  return (
    <ToastContext.Provider value={{ toast, show }}>
      {toast !== undefined && (
        <div
          className="r-toast"
          data-level={toast.level}
          // Only a failure interrupts a screen reader mid-sentence; a success
          // waits its turn.
          role={toast.level === "error" ? "alert" : "status"}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            className="r-iconButton"
            onClick={() => setToast(undefined)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      {children}
    </ToastContext.Provider>
  );
}
