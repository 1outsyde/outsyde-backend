import { Resend } from 'resend';

const INVITE_FROM = process.env.RESEND_FROM_EMAIL
  ? `Outsyde <${process.env.RESEND_FROM_EMAIL}>`
  : 'Outsyde <invites@info.goutsyde.com>';

function getAppBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const replitDomains = process.env.REPLIT_DOMAINS?.split(',')[0];
  if (replitDomains) return `https://${replitDomains}`;
  return 'https://goutsyde.com';
}

function buildInviteHtml(businessName: string, inviteCode: string, role: string): string {
  const acceptUrl = `${getAppBaseUrl()}/accept-invite?code=${inviteCode}`;
  const roleLabel = role === 'manager' ? 'Manager' : 'Staff Member';
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f5a623, #f7b84b); padding: 24px; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">You're Invited to Join ${businessName}</h1>
      </div>
      <div style="padding: 32px; background: #ffffff;">
        <p style="font-size: 16px; color: #333; margin-top: 0;">
          You've been invited to join <strong>${businessName}</strong> as a <strong>${roleLabel}</strong> on Outsyde.
        </p>
        <p style="font-size: 14px; color: #555;">
          Click the button below to accept your invitation and set up your account.
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${acceptUrl}"
             style="background: #f5a623; color: white; padding: 14px 36px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; display: inline-block;">
            Accept Invitation
          </a>
        </div>
        <p style="font-size: 13px; color: #888;">
          Or copy this link into your browser:<br/>
          <a href="${acceptUrl}" style="color: #f5a623;">${acceptUrl}</a>
        </p>
        <p style="font-size: 12px; color: #aaa; margin-top: 24px;">
          This invitation expires in 7 days. If you weren't expecting this, you can safely ignore it.
        </p>
      </div>
      <div style="background: #f5f5f5; padding: 16px; text-align: center; color: #999; font-size: 12px;">
        <p style="margin: 0;">Outsyde — Local Business Platform</p>
      </div>
    </div>
  `;
}

function buildInviteText(businessName: string, inviteCode: string, role: string): string {
  const acceptUrl = `${getAppBaseUrl()}/accept-invite?code=${inviteCode}`;
  const roleLabel = role === 'manager' ? 'Manager' : 'Staff Member';
  return `You've been invited to join ${businessName} as a ${roleLabel} on Outsyde.

Accept your invitation here: ${acceptUrl}

This invitation expires in 7 days.
`;
}

export async function sendStaffInviteEmail(
  toEmail: string,
  businessName: string,
  inviteCode: string,
  role: string,
): Promise<{ sent: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const msg = '[resendService] RESEND_API_KEY not set — skipping email send';
    console.warn(msg);
    return { sent: false, error: msg };
  }

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: INVITE_FROM,
      to: toEmail,
      subject: `You're invited to join ${businessName} on Outsyde`,
      html: buildInviteHtml(businessName, inviteCode, role),
      text: buildInviteText(businessName, inviteCode, role),
    });

    if (result.error) {
      const errMsg = typeof result.error === 'object' && result.error !== null
        ? (result.error as { message?: string }).message ?? JSON.stringify(result.error)
        : String(result.error);
      console.warn(`[resendService] Email send failed for ${toEmail}:`, errMsg);
      return { sent: false, error: errMsg };
    }

    console.log(`[resendService] Staff invite sent to ${toEmail} (code: ${inviteCode})`);
    return { sent: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[resendService] Unexpected error sending invite to ${toEmail}:`, errMsg);
    return { sent: false, error: errMsg };
  }
}

/**
 * SMS stub — logs only, never sends.
 * Wire a real provider here when SMS_ENABLED is set and a provider is configured.
 */
export async function sendStaffInviteSMS(
  toPhone: string,
  businessName: string,
  inviteCode: string,
): Promise<{ sent: boolean; error?: string }> {
  const smsEnabled = process.env.SMS_ENABLED === 'true';
  if (!smsEnabled) {
    console.log(
      `[resendService] SMS stub — would send invite to ${toPhone} for ${businessName} (code: ${inviteCode})`,
    );
    return { sent: false, error: 'SMS not enabled' };
  }
  console.warn('[resendService] SMS_ENABLED=true but no provider is wired. Stubbing send.');
  return { sent: false, error: 'No SMS provider configured' };
}
