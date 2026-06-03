"use client";

import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type ToastTone = "default" | "error";

type ToastAction = {
  label: string;
  onClick: () => void;
};

type Toast = {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
  action?: ToastAction;
};

type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  action?: ToastAction;
};

type ToastContextValue = {
  showToast: (toast: ToastInput) => void;
  showError: (message: string, title?: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);
const TOAST_DURATION_MS = 5000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((input: ToastInput) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [
      ...current.slice(-2),
      {
        id,
        title: input.title,
        tone: input.tone ?? "default",
        ...(input.description ? { description: input.description } : {}),
        ...(input.action ? { action: input.action } : {}),
      },
    ]);
  }, []);

  const showError = useCallback(
    (message: string, title = "Something went wrong") => {
      showToast({ title, description: message, tone: "error" });
    },
    [showToast],
  );

  const value = useMemo(() => ({ showToast, showError }), [showToast, showError]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider.");
  return value;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.id]);

  return (
    <div
      className={`pointer-events-auto rounded-md border bg-surface px-3.5 py-3 shadow-[0_12px_32px_rgba(15,15,15,0.12)] ${
        toast.tone === "error" ? "border-danger-border" : "border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p
            className={`text-[13px] font-medium ${
              toast.tone === "error" ? "text-danger" : "text-ink"
            }`}
          >
            {toast.title}
          </p>
          {toast.description ? (
            <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">{toast.description}</p>
          ) : null}
        </div>
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
            className="shrink-0 rounded px-1.5 py-0.5 text-[12.5px] font-medium leading-4 text-ink hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            {toast.action.label}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
          className="shrink-0 rounded px-1 text-[15px] leading-4 text-ink-subtle hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
