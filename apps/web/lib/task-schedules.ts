"use server";

import type { HarnessSpec } from "@opencompany/agent/task-runtime-types";
import {
  createTaskScheduleForUser as createSharedTaskScheduleForUser,
  deleteTaskScheduleForUser as deleteSharedTaskScheduleForUser,
  listTaskSchedulesForUser as listSharedTaskSchedulesForUser,
  updateTaskScheduleForUser as updateSharedTaskScheduleForUser,
} from "@opencompany/agent/task-schedules";
import { planTaskHarness } from "@/lib/task-runner";

const planningDependencies = {
  planHarness: ({ actorId, prompt }: { actorId: string; prompt: string }) =>
    planTaskHarness({ userWorkosId: actorId, prompt }),
};

export async function listTaskSchedulesForUser(userWorkosId: string) {
  return listSharedTaskSchedulesForUser(userWorkosId);
}

export async function createTaskScheduleForUser(input: {
  userWorkosId: string;
  workspaceId: string;
  name: string;
  sourceDescription?: string;
  cron: string;
  timezone?: string | null;
  prompt: string;
  plannedHarnessSpec?: HarnessSpec;
  now?: Date;
}) {
  return createSharedTaskScheduleForUser(input, planningDependencies);
}

export async function updateTaskScheduleForUser(
  userWorkosId: string,
  scheduleId: string,
  input: ScheduleUpdateInput,
) {
  return updateSharedTaskScheduleForUser(userWorkosId, scheduleId, input, planningDependencies);
}

export async function deleteTaskScheduleForUser(userWorkosId: string, scheduleId: string) {
  return deleteSharedTaskScheduleForUser(userWorkosId, scheduleId);
}

type ScheduleUpdateInput = {
  name: string;
  sourceDescription?: string;
  cron: string;
  timezone?: string | null;
  prompt: string;
};
