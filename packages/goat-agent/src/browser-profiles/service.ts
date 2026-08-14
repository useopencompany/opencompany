import type { Actor } from "@opencompany/core";
import {
  type BrowserProfileView,
  completeLoginSession,
  createBrowserProfile,
  createLoginSession,
  deleteBrowserProfile,
  listBrowserProfilesForUser,
  resolveLiveViewUrl,
} from "./index";

type DbLike = any;

// Browser profiles are owned by the acting user, not the workspace: every
// operation below scopes by the actor's WorkOS user id, which is the same
// ownership rule the retired web routes enforced.
export class GoatBrowserProfileApplicationService {
  constructor(private readonly db: DbLike) {}

  list(actor: Actor): Promise<BrowserProfileView[]> {
    return listBrowserProfilesForUser(actor.userId, this.db);
  }

  create(actor: Actor, input: { name: string; url: string }): Promise<BrowserProfileView> {
    return createBrowserProfile(
      { userWorkosId: actor.userId, name: input.name, siteUrl: input.url },
      this.db,
    );
  }

  async remove(actor: Actor, profileId: string): Promise<void> {
    await deleteBrowserProfile({ userWorkosId: actor.userId, profileId }, this.db);
  }

  createLoginSession(
    actor: Actor,
    profileId: string,
  ): Promise<{ sessionId: string; liveViewUrl: string }> {
    return createLoginSession({ userWorkosId: actor.userId, profileId }, this.db);
  }

  async completeLoginSession(actor: Actor, profileId: string, sessionId: string): Promise<void> {
    await completeLoginSession({ userWorkosId: actor.userId, profileId, sessionId }, this.db);
  }

  resolveLiveViewUrl(actor: Actor, profileId: string, sessionId: string): Promise<string> {
    return resolveLiveViewUrl({ userWorkosId: actor.userId, profileId, sessionId }, this.db);
  }
}
