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
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You're Invited to Join ${businessName}</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0a0a0a;">
    <tr>
      <td align="center" style="padding:40px 16px 0;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

          <!-- Header: GO OUTSYDE wordmark -->
          <tr>
            <td align="center" style="padding:0 0 8px;">
              <p style="margin:0;font-size:28px;font-weight:bold;letter-spacing:4px;text-transform:uppercase;color:#E8B930;">
                GO OUTSYDE
              </p>
              <p style="margin:6px 0 0;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#666666;">
                Local Business Platform
              </p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:20px 0;">
              <div style="height:1px;background-color:#222222;"></div>
            </td>
          </tr>

          <!-- Content card -->
          <tr>
            <td style="background-color:#141414;border-radius:8px;padding:32px;">

              <!-- Card section header -->
              <p style="margin:0 0 4px;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;color:#E8B930;">
                Staff Invitation
              </p>
              <h1 style="margin:0 0 24px;font-size:22px;font-weight:bold;color:#ffffff;line-height:1.3;">
                You're Invited to Join<br/>${businessName}
              </h1>

              <!-- Body -->
              <p style="margin:0 0 16px;font-size:15px;color:#ffffff;line-height:1.6;">
                You've been invited to join <strong style="color:#E8B930;">${businessName}</strong>
                as a <strong style="color:#ffffff;">${roleLabel}</strong> on Go Outsyde.
              </p>
              <p style="margin:0 0 32px;font-size:14px;color:#999999;line-height:1.6;">
                Click the button below to accept your invitation and set up your account.
              </p>

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 32px;">
                <tr>
                  <td align="center" style="background-color:#E8B930;border-radius:6px;">
                    <a href="${acceptUrl}"
                       style="display:inline-block;padding:14px 40px;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;text-decoration:none;color:#0a0a0a;">
                      Accept Invitation
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Fallback link -->
              <p style="margin:0 0 8px;font-size:12px;color:#666666;">
                Or copy this link into your browser:
              </p>
              <p style="margin:0 0 24px;font-size:12px;word-break:break-all;">
                <a href="${acceptUrl}" style="color:#E8B930;text-decoration:none;">${acceptUrl}</a>
              </p>

              <!-- Expiry note -->
              <div style="height:1px;background-color:#1e1e1e;margin:0 0 24px;"></div>
              <p style="margin:0;font-size:12px;color:#666666;line-height:1.6;">
                This invitation expires in 7 days. If you weren't expecting this, you can safely ignore it.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:24px 0 40px;">
              <p style="margin:0;font-size:12px;color:#444444;">
                &copy; ${year} Go Outsyde. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildInviteText(businessName: string, inviteCode: string, role: string): string {
  const acceptUrl = `${getAppBaseUrl()}/accept-invite?code=${inviteCode}`;
  const roleLabel = role === 'manager' ? 'Manager' : 'Staff Member';
  return `GO OUTSYDE — Staff Invitation

You've been invited to join ${businessName} as a ${roleLabel} on Go Outsyde.

Accept your invitation here:
${acceptUrl}

This invitation expires in 7 days. If you weren't expecting this, you can safely ignore it.

© ${new Date().getFullYear()} Go Outsyde. All rights reserved.
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
