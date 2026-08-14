export type ProductAnalyticsPerson = {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  workspaceId?: string | null;
};

function nonEmpty(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function productAnalyticsPersonProperties(person: ProductAnalyticsPerson) {
  const email = nonEmpty(person.email);
  const firstName = nonEmpty(person.firstName);
  const lastName = nonEmpty(person.lastName);
  const workspaceId = nonEmpty(person.workspaceId);
  const name = [firstName, lastName].filter(Boolean).join(" ");

  return {
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(email ? { email } : {}),
    ...(firstName ? { first_name: firstName } : {}),
    ...(lastName ? { last_name: lastName } : {}),
    ...(name ? { name } : {}),
  };
}
