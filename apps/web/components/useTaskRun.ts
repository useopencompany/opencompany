"use client";

import type {
  LegacyTaskHistoryDto,
  LegacyTaskHistoryEventDto,
  LegacyTaskHistoryMessageDto,
} from "@opencompany/protocol";
import { useEffect, useMemo, useState } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { legacyTaskDtoToRow, taskReadModelToRow } from "@/lib/headless-task-collections";
import { getHeadlessTask, getLegacyTaskCompatibilityHistory } from "@/lib/headless-task-commands";
import { buildHarnessRun, type HarnessRunViewModel } from "@/lib/task-harness-run";

/**
 * The harness run behind a Task id, for any surface that renders the canonical Task view.
 *
 * Live Task rows answer immediately with a placeholder run so the view can paint, and the
 * authoritative record (canonical, or pre-cutover history) replaces it when the fetch lands.
 */
export function useTaskRun(taskId: string) {
  const { featureFlags, tasks, taskRows } = useAppData();
  const [serverState, setServerState] = useState<{
    taskId: string;
    run: HarnessRunViewModel | null;
    notFound: boolean;
  } | null>(null);
  const normalizedTaskId = taskId.trim().toUpperCase();
  const liveTask = useMemo(
    () =>
      taskRows.find((task) => task.id === taskId || task.display_id === normalizedTaskId) ??
      tasks.find((task) => task.id === taskId || task.displayId === normalizedTaskId) ??
      null,
    [normalizedTaskId, taskId, taskRows, tasks],
  );
  const placeholderRun = useMemo(
    () => (liveTask ? buildHarnessRun({ task: liveTask, messages: [], events: [] }) : null),
    [liveTask],
  );

  useEffect(() => {
    if (!featureFlags.taskSpawning) return;
    const controller = new AbortController();
    void getHeadlessTask(taskId, {
      fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }),
    })
      .then((task) => {
        if (task) {
          return buildHarnessRun({
            task: taskReadModelToRow(task),
            messages: [],
            events: [],
          });
        }
        return getLegacyTaskCompatibilityHistory(taskId, {
          fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }),
        }).then((history: LegacyTaskHistoryDto | null) => {
          if (!history) {
            setServerState({ taskId, run: null, notFound: true });
            return null;
          }
          return buildHarnessRun({
            task: legacyTaskDtoToRow(history.task),
            messages: history.messages.map((message: LegacyTaskHistoryMessageDto) => ({
              id: message.id,
              task_id: history.task.id,
              user_workos_id: "",
              role: message.role,
              status: message.status,
              content: message.content,
              model_message: null,
              tool_name: message.toolName,
              tool_call_id: message.toolCallId,
              response_to_message_id: null,
              created_at: message.createdAt,
              updated_at: message.updatedAt,
              completed_at: message.completedAt,
            })),
            events: history.events.map((event: LegacyTaskHistoryEventDto) => ({
              id: event.id,
              task_id: history.task.id,
              user_workos_id: "",
              message_id: event.messageId,
              type: event.type,
              payload: event.payload,
              created_at: event.createdAt,
            })),
          });
        });
      })
      .then((run) => {
        if (run) setServerState({ taskId, run, notFound: false });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [featureFlags.taskSpawning, taskId]);

  const currentServerState = serverState?.taskId === taskId ? serverState : null;
  if (currentServerState?.run) return currentServerState.run;
  if (currentServerState?.notFound && !placeholderRun) return null;
  return placeholderRun;
}
