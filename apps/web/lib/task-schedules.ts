"use server";

import type { GoatHarnessSpec } from "@opencompany/db/goat-schema";
import {
  createGoatTaskScheduleForUser as createSharedGoatTaskScheduleForUser,
  deleteGoatTaskScheduleForUser as deleteSharedGoatTaskScheduleForUser,
  listGoatTaskSchedulesForUser as listSharedGoatTaskSchedulesForUser,
  updateGoatTaskScheduleForUser as updateSharedGoatTaskScheduleForUser,
} from "@opencompany/goat-agent/task-schedules";
import { planGoatTaskHarness } from "@/lib/task-runner";

const planningDependencies = {
  planHarness: ({ actorId, prompt }: { actorId: string; prompt: string }) =>
    planGoatTaskHarness({ userWorkosId: actorId, prompt }),
};

export async function listGoatTaskSchedulesForUser(userWorkosId: string) {
  return listSharedGoatTaskSchedulesForUser(userWorkosId);
}

export async function createGoatTaskScheduleForUser(input: {
  userWorkosId: string;
  workspaceId: string;
  name: string;
  sourceDescription?: string;
  cron: string;
  timezone?: string | null;
  prompt: string;
  plannedHarnessSpec?: GoatHarnessSpec;
  now?: Date;
}) {
  return createSharedGoatTaskScheduleForUser(input, planningDependencies);
}

export async function updateGoatTaskScheduleForUser(
  userWorkosId: string,
  scheduleId: string,
  input: ScheduleUpdateInput,
) {
  return updateSharedGoatTaskScheduleForUser(userWorkosId, scheduleId, input, planningDependencies);
}

export async function deleteGoatTaskScheduleForUser(userWorkosId: string, scheduleId: string) {
  return deleteSharedGoatTaskScheduleForUser(userWorkosId, scheduleId);
}

type ScheduleUpdateInput = {
  name: string;
  sourceDescription?: string;
  cron: string;
  timezone?: string | null;
  prompt: string;
};
