// Minimal structural surface of the WorkOS Node SDK used by workspace
// provisioning and organization sync. Kept structural so this package does not
// depend on @workos-inc/node; callers inject their concrete WorkOS client.
export type WorkOSOrganizationLike = { id: string; name: string };

export type WorkOSOrganizationMembershipLike = {
  id: string;
  status: string;
  role?: { slug?: string };
};

export type WorkOSClientLike = {
  organizations: {
    createOrganization(
      payload: { name: string; externalId: string; metadata: Record<string, string> },
      options?: { idempotencyKey?: string },
    ): Promise<WorkOSOrganizationLike>;
    deleteOrganization(organizationId: string): Promise<void>;
    getOrganizationByExternalId(externalId: string): Promise<WorkOSOrganizationLike>;
  };
  userManagement: {
    createOrganizationMembership(payload: {
      organizationId: string;
      userId: string;
      roleSlug: string;
    }): Promise<unknown>;
    listOrganizationMemberships(payload: {
      organizationId: string;
      userId: string;
      statuses: ("active" | "pending" | "inactive")[];
    }): Promise<{ data: WorkOSOrganizationMembershipLike[] }>;
    updateOrganizationMembership(
      membershipId: string,
      payload: { roleSlug: string },
    ): Promise<unknown>;
  };
};
