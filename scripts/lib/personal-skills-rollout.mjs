export const PERSONAL_SKILLS_AUTHORIZATION_CAPABILITY = "v1";
export const PERSONAL_SKILLS_DRAIN_MS = 310_000;

export function assertPersonalSkillsAuthorization(service, payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.ok !== true ||
    payload.capabilities?.personalSkillsAuthorization !== PERSONAL_SKILLS_AUTHORIZATION_CAPABILITY
  ) {
    throw new Error(
      `${service} does not advertise Personal-skill authorization ${PERSONAL_SKILLS_AUTHORIZATION_CAPABILITY}.`,
    );
  }
}
