"use client";

import { newResourceId } from "@opencompany/core/resource-ids";
import { createApiClient, type ProjectDto } from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "@/lib/headless-chat-api";

export const PROJECTS_CHANGED_EVENT = "opencompany:projects-changed";

function client() {
  const baseUrl = headlessChatApiBaseUrl();
  return createApiClient(baseUrl, { fetch: createHeadlessChatApiFetch({ baseUrl }) });
}

async function data(response: Response): Promise<ProjectDto[]> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? "Projects could not be updated. Please try again.");
  }
  return (await response.json()).data;
}

export function newProjectId() {
  return newResourceId("project");
}

export async function listProjects() {
  return data(await client().v1.projects.$get());
}

export async function createProject(project: { id: string; name: string }) {
  return data(await client().v1.projects.$post({ json: project }));
}

export async function renameProject(projectId: string, name: string) {
  return data(
    await client().v1.projects[":projectId"].$patch({ param: { projectId }, json: { name } }),
  );
}

export async function deleteProject(projectId: string) {
  return data(await client().v1.projects[":projectId"].$delete({ param: { projectId } }));
}

export async function fileConversationInProject(projectId: string, conversationId: string) {
  return data(
    await client().v1.projects[":projectId"].conversations.$post({
      param: { projectId },
      json: { conversationId },
    }),
  );
}

export async function removeConversationFromProject(projectId: string, conversationId: string) {
  return data(
    await client().v1.projects[":projectId"].conversations[":conversationId"].$delete({
      param: { projectId, conversationId },
    }),
  );
}

// A chat started from a project row is filed by the API when the Conversation is created, but the
// sidebar row appears before that request lands. These local assignments keep the new row under
// its folder for the seconds in between, and are dropped once the server list reports the same
// membership (or contradicts it).
const localAssignments = new Map<string, string>();
const localAssignmentListeners = new Set<() => void>();

function publishLocalAssignments() {
  for (const listener of localAssignmentListeners) listener();
}

export function noteLocalProjectAssignment(projectId: string, conversationId: string) {
  localAssignments.set(conversationId, projectId);
  publishLocalAssignments();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
  }
}

/** Drops a pending assignment whose chat was never created, e.g. a first turn that failed. */
export function forgetLocalProjectAssignment(conversationId: string) {
  if (!localAssignments.delete(conversationId)) return;
  publishLocalAssignments();
}

export function subscribeLocalProjectAssignments(onStoreChange: () => void) {
  localAssignmentListeners.add(onStoreChange);
  return () => {
    localAssignmentListeners.delete(onStoreChange);
  };
}

export function localProjectAssignmentsSnapshot(): ReadonlyMap<string, string> {
  return localAssignments;
}

export function reconcileLocalProjectAssignments(projects: readonly ProjectDto[]) {
  const known = new Set(projects.flatMap((project) => project.conversationIds));
  let changed = false;
  for (const conversationId of localAssignments.keys()) {
    if (!known.has(conversationId)) continue;
    localAssignments.delete(conversationId);
    changed = true;
  }
  if (changed) publishLocalAssignments();
}

/** Merges pending local assignments into a server project list. */
export function projectsWithLocalAssignments(
  projects: readonly ProjectDto[],
  assignments: ReadonlyMap<string, string>,
): ProjectDto[] {
  if (assignments.size === 0) return projects as ProjectDto[];
  return projects.map((project) => {
    const pending = [...assignments]
      .filter(([, projectId]) => projectId === project.id)
      .map(([conversationId]) => conversationId)
      .filter((conversationId) => !project.conversationIds.includes(conversationId));
    return pending.length === 0
      ? project
      : { ...project, conversationIds: [...pending, ...project.conversationIds] };
  });
}
