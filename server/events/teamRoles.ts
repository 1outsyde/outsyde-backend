/**
 * Event team roles (p4-team steps 1 and 2, 2026-10-29). Stored in event_door_team.role / event_door_members.role
 * (075, widened by 083). "Event team" is everyone the host invites; each role is its own section:
 *   door           Admissions: scanner and guest list
 *   security       Security: call time, where to go, the host's notes
 *   host           Promoter: own link and own sales (step 3)
 *   entertainment  Entertainment (DJs, performers, MCs): set time, load in, the host's notes
 *   media          Media (photo, video): call time, where to go, the host's notes
 *   cohost         Co-host: sees everything the host sees for the event (access rules: step 2b)
 *   other          a role the host names (role_label, 083): times, where to go, the host's notes
 * One person can hold several roles at one event (081/082). Clients that send no role get "door", so old app builds
 * and today's website keep working. Every schedule field (event_team_schedules, 083) is optional for every role.
 */

export const TEAM_ROLES = ["door", "security", "host", "entertainment", "media", "cohost", "other"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

const NAMES: Record<Exclude<TeamRole, "other">, string> = {
  door: "Admissions", security: "Security", host: "Promoter", entertainment: "Entertainment", media: "Media", cohost: "Co-host",
};

/** What screens and copy call the section. Other uses the host's name for it. */
export function roleName(role: TeamRole, label?: string | null): string {
  if (role === "other") return label && label.trim() ? label.trim() : "Event team";
  return NAMES[role];
}

const LABEL_MAX = 40;
/** Letters (any language), digits, spaces and a few marks. Never markup. */
const LABEL_RE = new RegExp("^[\\p{L}\\p{N} &'.,/()]+$", "u");

/** roleLabel is required for "other" and refused for every other role. */
export function parseRoleLabel(role: TeamRole, raw: unknown): { ok: true; label: string | null } | { ok: false; message: string } {
  if (role !== "other") {
    return raw === undefined || raw === null ? { ok: true, label: null } : { ok: false, message: "roleLabel: only for the Other role." };
  }
  const label = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!label || label.length > LABEL_MAX) return { ok: false, message: `roleLabel: type a name for this role (up to ${LABEL_MAX} characters).` };
  if (!LABEL_RE.test(label)) return { ok: false, message: "roleLabel: letters, numbers, spaces and & ' . , / ( ) only." };
  return { ok: true, label };
}

const DESCRIPTIONS: Record<TeamRole, string> = {
  door: "Scans tickets and sees the guest list.",
  security: "Sees their call time, where to go and your notes.",
  host: "Gets their own link and sees the tickets sold through it.",
  entertainment: "Sees their set time, load in and your notes.",
  media: "Sees their call time, where to go and your notes.",
  cohost: "Sees everything you see for the event, including sales, the guest list and the team.",
  other: "Sees their times, where to go and your notes.",
};

/** The host's team list: each person's section and what it gives them. */
export function roleInfo(role: TeamRole, label?: string | null): { name: string; description: string } {
  return { name: roleName(role, label), description: DESCRIPTIONS[role] };
}

/** "for Admissions" / "as a Promoter" / "as a Co-host". */
const forRole = (role: TeamRole, label?: string | null) =>
  role === "host" || role === "cohost" ? `as a ${roleName(role)}` : `for ${roleName(role, label)}`;

/** Push and Activity title for an invite. */
export function inviteTitle(hostName: string, role: TeamRole, label?: string | null): string {
  if (role === "cohost") return `${hostName} invited you to co-host with them`;
  return `${hostName} invited you to their Event team ${forRole(role, label)}`;
}

const JOINED_BODY: Record<TeamRole, (what: string) => string> = {
  door: (w) => `They can scan tickets for ${w}.`,
  security: (w) => `They'll see their call time and where to go for ${w}.`,
  host: (w) => `They'll get their own link for ${w}.`,
  entertainment: (w) => `They'll see their set time and load in for ${w}.`,
  media: (w) => `They'll see their call time and where to go for ${w}.`,
  cohost: (w) => `They see everything you see for ${w}.`,
  other: (w) => `They'll see their times and where to go for ${w}.`,
};

/** Push to the host when someone accepts. `what` is the event title or "all your events". */
export function joinedCopy(name: string, role: TeamRole, what: string, label?: string | null): { title: string; body: string } {
  const title = role === "cohost" ? `${name} is co-hosting with you` : `${name} joined your Event team ${forRole(role, label)}`;
  return { title, body: JOINED_BODY[role](what) };
}

const EMAIL_WHAT: Record<TeamRole, string> = {
  door: "you can scan tickets and see the guest list",
  security: "you'll see your call time, where to go and the host's notes",
  host: "you'll get your own link to share and see the tickets sold through it",
  entertainment: "you'll see your set time, load in and the host's notes",
  media: "you'll see your call time, where to go and the host's notes",
  cohost: "you'll see everything the host sees for the event, including sales, the guest list and the team,",
  other: "you'll see your times, where to go and the host's notes",
};

/**
 * Invite email copy. `host`, `what` and `label` arrive already HTML escaped (`what` may hold <strong>); the subject
 * is plain text, so the caller passes raw values for it. Lines are paragraphs.
 */
export function inviteEmailCopy(role: TeamRole, host: string, what: string, label?: string | null): { subject: string; heading: string; intro: string; lines: [string, string] } {
  const subject = inviteTitle(host, role, label);
  const first: Record<TeamRole, string> = {
    door: `${host} wants you on Admissions for ${what}, checking guests in at the door.`,
    security: `${host} wants you on Security for ${what}.`,
    host: `${host} wants you to promote ${what}.`,
    entertainment: `${host} wants you on Entertainment for ${what}.`,
    media: `${host} wants you on Media for ${what}, taking photos or video.`,
    cohost: `${host} wants you to co-host ${what}.`,
    other: `${host} wants you on their Event team as ${roleName("other", label)} for ${what}.`,
  };
  return {
    subject,
    heading: role === "cohost" ? "you're invited to co-host" : "you're invited to the Event team",
    intro: `${subject}.`,
    lines: [first[role], `If you accept, ${EMAIL_WHAT[role]} in the Outsyde app or on goutsyde.com.`],
  };
}

/** 409 messages, per role (one person can hold several). */
export function duplicateMessage(role: TeamRole, code: "ALREADY_INVITED" | "ALREADY_ON_TEAM", label?: string | null): string {
  return code === "ALREADY_ON_TEAM"
    ? `They are already on your Event team ${forRole(role, label)}.`
    : `You already invited them ${forRole(role, label)}.`;
}

/**
 * Push and Activity types. Door keeps door_team_invite / door_team_accepted, which today's app opens on the door
 * screens. Every other role uses team_invite / team_accepted, which today's app doesn't route to the scanner, so
 * an old app build never shows them as a door invite.
 */
export function pushTypes(role: TeamRole): { invite: string; accepted: string } {
  return role === "door" ? { invite: "door_team_invite", accepted: "door_team_accepted" } : { invite: "team_invite", accepted: "team_accepted" };
}
