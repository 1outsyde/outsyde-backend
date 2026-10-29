/**
 * Event team roles (p4-team step 1, 2026-10-29). Stored in event_door_team.role / event_door_members.role (075):
 *   door      Admissions: scanner and guest list (shown as "Admissions" by the app and goutsyde.com, steps 5 and 6)
 *   security  call time and where to go (step 2); no scanner, no guest list
 *   host      host / promoter: own link and own sales (step 3); no scanner
 * One person can hold several roles at one event (migration 081/082). Clients that send no role get "door", so
 * old app builds and today's website keep working. The door role keeps its "door team" wording until the app and
 * the site rename it to Admissions together.
 */

export const TEAM_ROLES = ["door", "security", "host"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** Push and Activity title for an invite. */
export function inviteTitle(hostName: string, role: TeamRole): string {
  if (role === "security") return `${hostName} invited you to their Security team`;
  if (role === "host") return `${hostName} invited you to host and promote with them`;
  return `${hostName} invited you to their door team`;
}

/** Push to the host when someone accepts. `what` is the event title or "your events". */
export function joinedCopy(name: string, role: TeamRole, what: string): { title: string; body: string } {
  if (role === "security") return { title: `${name} joined your Security team`, body: `They'll see when to arrive and where to go for ${what}.` };
  if (role === "host") return { title: `${name} is hosting and promoting with you`, body: `They'll get their own link for ${what}.` };
  return { title: `${name} joined your door team`, body: `They can scan tickets for ${what}.` };
}

/**
 * Invite email copy. `host` and `what` arrive already HTML escaped (`what` may hold <strong>); the subject is
 * plain text, so the caller passes the raw host name for it. Lines are paragraphs.
 */
export function inviteEmailCopy(role: TeamRole, host: string, what: string): { subject: string; heading: string; intro: string; lines: [string, string] } {
  if (role === "security") {
    return {
      subject: `${host} invited you to their Security team`,
      heading: "you're invited to the Security team",
      intro: `${host} invited you to their Security team.`,
      lines: [
        `${host} wants you on security for ${what}.`,
        "If you accept, you'll see when to arrive and where to go in the Outsyde app or on goutsyde.com. You won't see sales, the guest list or anyone's contact details.",
      ],
    };
  }
  if (role === "host") {
    return {
      subject: `${host} invited you to host and promote with them`,
      heading: "you're invited to host and promote",
      intro: `${host} invited you to host and promote with them.`,
      lines: [
        `${host} wants you to help host and promote ${what}.`,
        "If you accept, you'll get your own link to share and see the tickets sold through it. You won't see anyone's contact details.",
      ],
    };
  }
  return {
    subject: `${host} invited you to their door team`,
    heading: "you're invited to the door team",
    intro: `${host} invited you to their door team.`,
    lines: [
      `${host} wants you to help check guests in at the door for ${what}.`,
      "If you accept, you can scan tickets and see the guest list in the Outsyde app or on goutsyde.com. You won't see sales, earnings or anyone's contact details.",
    ],
  };
}

/** 409 messages. Door keeps its old wording; other roles say "for that role", since one person can hold several. */
export function duplicateMessage(role: TeamRole, code: "ALREADY_INVITED" | "ALREADY_ON_TEAM"): string {
  if (role === "door") return code === "ALREADY_ON_TEAM" ? "They are already on your door team." : "You already invited them. They can scan once they accept.";
  return code === "ALREADY_ON_TEAM" ? "They already have that role on your team." : "You already invited them for that role.";
}

/**
 * Push and Activity types. Door keeps door_team_invite / door_team_accepted, which today's app opens on the door
 * screens. Security and host use team_invite / team_accepted, which today's app doesn't route to the scanner, so
 * an old app build never shows them as a door team invite.
 */
export function pushTypes(role: TeamRole): { invite: string; accepted: string } {
  return role === "door" ? { invite: "door_team_invite", accepted: "door_team_accepted" } : { invite: "team_invite", accepted: "team_accepted" };
}
