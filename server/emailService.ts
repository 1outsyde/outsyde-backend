import { Resend } from 'resend';
import type { EmailLogTag } from './emailHistory';
import type { Business, InfluencerApplication, Photographer, User } from '@shared/schema';
import {
  buildVendorApplicationSections,
  renderSectionsHtml,
  renderSectionsText,
  escapeHtml,
  NOT_PROVIDED,
  type DetailSection,
} from './adminApplicationDetails';
import { buildPhotographerApplicationSections } from './photographerApplicationDetails';
import { buildInfluencerApplicationSections, type ApplicantLike } from './influencerApplicationDetails';

// History logging for emails to customers, vendors and photographers (PR C2). emailHistory is loaded
// lazily so importing this file still never loads the database module (server/accountSetup tests and
// scripts import the email helpers on their own). Fire and forget, never throws.
function logTransactionalEmail(
  tag: EmailLogTag | undefined,
  to: string | null | undefined,
  outcome: { resendId?: string | null; error?: unknown },
): void {
  if (!tag || !to) return;
  import('./emailHistory')
    .then((m) => m.logTransactionalEmail(tag, to, outcome))
    .catch((err) => console.error('[EmailHistory] could not load the logger:', err));
}

const FROM_ORDERS = 'orders@info.goutsyde.com';

// Platform admin copy of every paid-transaction receipt and internal alert.
export const ADMIN_NOTIFICATION_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL || 'info@goutsyde.com';

function getAppBaseUrl(): string {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL;
  }
  const replitDomains = process.env.REPLIT_DOMAINS?.split(',')[0];
  if (replitDomains) {
    return `https://${replitDomains}`;
  }
  return '';
}

export async function isEmailConfigured(): Promise<boolean> {
  return !!process.env.RESEND_API_KEY;
}

export interface AdminEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Set only for emails to customers or vendors; internal alerts stay unlogged (PR C2). */
  log?: EmailLogTag;
  /** Optional Reply-To (estimate requests: the vendor replies straight to the customer). */
  replyTo?: string;
}

export async function sendAdminEmail(params: AdminEmailParams): Promise<boolean> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('[emailService] RESEND_API_KEY not set');
    }
    const client = new Resend(apiKey);

    const result = await client.emails.send({
      from: FROM_ORDERS,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    });

    if (result.error) {
      console.error('[Email] Failed to send email:', result.error);
      logTransactionalEmail(params.log, params.to, { error: result.error.message ?? result.error });
      return false;
    }

    console.log(`[Email] Sent to ${params.to}: ${params.subject}`);
    logTransactionalEmail(params.log, params.to, { resendId: result.data?.id });
    return true;
  } catch (error) {
    console.error('[Email] Error sending email:', error);
    if (process.env.RESEND_API_KEY) logTransactionalEmail(params.log, params.to, { error });
    return false;
  }
}

export async function sendNewConsumerSignupEmail(params: {
  adminEmail: string;
  userName: string;
  userEmail: string;
  username: string;
  city?: string | null;
  state?: string | null;
  userId: string;
}): Promise<boolean> {
  const subject = `New Consumer Signup: ${params.userName}`;
  const location = params.city && params.state ? `${params.city}, ${params.state}` : null;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f5a623, #f7b84b); padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">New Consumer Signup</h1>
      </div>

      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #333;">A new consumer has joined Outsyde:</p>

        <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h2 style="color: #333; margin-top: 0;">${params.userName}</h2>
          <p style="margin: 8px 0;"><strong>Username:</strong> @${params.username}</p>
          <p style="margin: 8px 0;"><strong>Email:</strong> ${params.userEmail}</p>
          ${location ? `<p style="margin: 8px 0;"><strong>Location:</strong> ${location}</p>` : ''}
        </div>

        <div style="text-align: center; margin-top: 30px;">
          <a href="${getAppBaseUrl()}/admin/users/${params.userId}"
             style="background: #f5a623; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            View User
          </a>
        </div>
      </div>

      <div style="background: #f5f5f5; padding: 15px; text-align: center; color: #666; font-size: 12px;">
        <p>This is an automated notification from Outsyde.</p>
      </div>
    </div>
  `;

  const baseUrl = getAppBaseUrl();
  const text = `
New Consumer Signup: ${params.userName}

A new consumer has joined Outsyde:

Name: ${params.userName}
Username: @${params.username}
Email: ${params.userEmail}
${location ? `Location: ${location}` : ''}

${baseUrl ? `View User: ${baseUrl}/admin/users/${params.userId}` : 'Log in to the admin panel to view this user.'}
  `;

  return sendAdminEmail({
    to: ADMIN_NOTIFICATION_EMAIL,
    subject,
    html,
    text,
  });
}

export async function sendNewVendorApplicationEmail(params: {
  adminEmail: string;
  businessName: string;
  businessCategory: string;
  ownerName: string;
  ownerEmail: string;
  location?: string | null;
  businessId: string;
  /** Saved rows (2026-10-17). When present the email lists every signup answer. */
  business?: Business | null;
  owner?: (Pick<User, "name" | "email" | "phone" | "username" | "address" | "city" | "state" | "zipCode" | "createdAt"> & { source?: string | null }) | null;
}): Promise<boolean> {
  const subject = `New Vendor Application: ${params.businessName}`;
  const reviewBase = (process.env.FRONTEND_URL || getAppBaseUrl() || 'https://www.goutsyde.com').replace(/\/+$/, '');
  const reviewUrl = `${reviewBase}/admin/applications/${encodeURIComponent(params.businessId)}`;

  // Fallback rows when the saved records could not be loaded (never blocks the alert).
  const sections: DetailSection[] = params.business
    ? buildVendorApplicationSections(params.business, params.owner ?? null)
    : [{
        title: 'Business',
        rows: [
          { label: 'Business name', value: params.businessName || NOT_PROVIDED },
          { label: 'Industry', value: params.businessCategory || NOT_PROVIDED },
          { label: 'Owner', value: params.ownerName || NOT_PROVIDED },
          { label: 'Email', value: params.ownerEmail || NOT_PROVIDED },
          { label: 'Location', value: params.location || NOT_PROVIDED },
        ],
      }];

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f5a623, #f7b84b); padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">New Vendor Application</h1>
      </div>

      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #333; margin-top: 0;">A new business has applied to join Outsyde. Here is everything they entered.</p>
        ${renderSectionsHtml(sections)}
        <div style="text-align: center; margin-top: 30px;">
          <a href="${escapeHtml(reviewUrl)}"
             style="background: #f5a623; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Review Application
          </a>
        </div>
      </div>

      <div style="background: #f5f5f5; padding: 15px; text-align: center; color: #666; font-size: 12px;">
        <p>This is an automated notification from Outsyde.</p>
      </div>
    </div>
  `;

  const text = `New Vendor Application: ${params.businessName}

A new business has applied to join Outsyde. Here is everything they entered.

${renderSectionsText(sections)}

Review: ${reviewUrl}
`;

  return sendAdminEmail({
    to: ADMIN_NOTIFICATION_EMAIL,
    subject,
    html,
    text,
  });
}

export async function sendNewPhotographerApplicationEmail(params: {
  adminEmail: string;
  displayName: string;
  ownerName: string;
  ownerEmail: string;
  location?: string | null;
  specialties?: string[];
  photographerId: string;
  /** Saved rows (2026-10-18). When present the email lists every signup answer. */
  photographer?: Photographer | null;
  owner?: (Pick<User, "name" | "email" | "phone" | "username" | "address" | "city" | "state" | "zipCode" | "createdAt"> & { source?: string | null }) | null;
}): Promise<boolean> {
  const subject = `New Photographer: ${params.displayName}`;
  const reviewBase = (process.env.FRONTEND_URL || getAppBaseUrl() || 'https://www.goutsyde.com').replace(/\/+$/, '');
  const reviewUrl = `${reviewBase}/admin/photographers/${encodeURIComponent(params.photographerId)}`;

  // Fallback rows when the saved records could not be loaded (never blocks the alert).
  const sections: DetailSection[] = params.photographer
    ? buildPhotographerApplicationSections(params.photographer, params.owner ?? null)
    : [{
        title: 'Profile',
        rows: [
          { label: 'Display name', value: params.displayName || NOT_PROVIDED },
          { label: 'Owner', value: params.ownerName || NOT_PROVIDED },
          { label: 'Email', value: params.ownerEmail || NOT_PROVIDED },
          { label: 'Location', value: params.location || NOT_PROVIDED },
          { label: 'Specialties', value: params.specialties && params.specialties.length ? params.specialties.join('; ') : NOT_PROVIDED },
        ],
      }];

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f5a623, #f7b84b); padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">New Photographer</h1>
      </div>

      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #333; margin-top: 0;">A new photographer joined Outsyde. Their profile is public right away. Here is everything they entered.</p>
        ${renderSectionsHtml(sections)}
        <div style="text-align: center; margin-top: 30px;">
          <a href="${escapeHtml(reviewUrl)}"
             style="background: #f5a623; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Review Photographer
          </a>
        </div>
      </div>

      <div style="background: #f5f5f5; padding: 15px; text-align: center; color: #666; font-size: 12px;">
        <p>This is an automated notification from Outsyde.</p>
      </div>
    </div>
  `;

  const text = `New Photographer: ${params.displayName}

A new photographer joined Outsyde. Their profile is public right away. Here is everything they entered.

${renderSectionsText(sections)}

Review: ${reviewUrl}
`;

  return sendAdminEmail({
    to: ADMIN_NOTIFICATION_EMAIL,
    subject,
    html,
    text,
  });
}

/**
 * New influencer application alert (2026-10-18): every answer the applicant gave, escaped,
 * and a Review button to goutsyde.com/admin/influencers/:id. Internal alert: no history tag.
 */
export async function sendNewInfluencerApplicationEmail(params: {
  application: InfluencerApplication;
  applicant: ApplicantLike | null;
}): Promise<boolean> {
  const who = params.applicant?.name || (params.applicant?.username ? `@${params.applicant.username}` : 'Someone');
  const subject = `New Influencer Application: ${who}`;
  const reviewBase = (process.env.FRONTEND_URL || getAppBaseUrl() || 'https://www.goutsyde.com').replace(/\/+$/, '');
  const reviewUrl = `${reviewBase}/admin/influencers/${encodeURIComponent(params.application.id)}`;
  const sections = buildInfluencerApplicationSections(params.application, params.applicant);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f5a623, #f7b84b); padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">New Influencer Application</h1>
      </div>

      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #333; margin-top: 0;">Someone applied to the Outsyde influencer program. Here is everything they entered. Approve or reject from the admin dashboard.</p>
        ${renderSectionsHtml(sections)}
        <div style="text-align: center; margin-top: 30px;">
          <a href="${escapeHtml(reviewUrl)}"
             style="background: #f5a623; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Review Application
          </a>
        </div>
      </div>

      <div style="background: #f5f5f5; padding: 15px; text-align: center; color: #666; font-size: 12px;">
        <p>This is an automated notification from Outsyde.</p>
      </div>
    </div>
  `;

  const text = `New Influencer Application: ${who}

Someone applied to the Outsyde influencer program. Here is everything they entered. Approve or reject from the admin dashboard.

${renderSectionsText(sections)}

Review: ${reviewUrl}
`;

  return sendAdminEmail({
    to: ADMIN_NOTIFICATION_EMAIL,
    subject,
    html,
    text,
  });
}

export async function sendVendorApprovalEmail(params: {
  ownerEmail: string;
  ownerName: string;
  businessName: string;
  stripeOnboardingUrl?: string | null;
}): Promise<boolean> {
  const subject = `Congratulations! ${params.businessName} is Approved on Outsyde`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f5a623, #f7b84b); padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">Welcome to Outsyde!</h1>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #333;">Hi ${params.ownerName},</p>
        
        <p style="font-size: 16px; color: #333;">
          Great news! Your business <strong>${params.businessName}</strong> has been approved to join the Outsyde marketplace.
        </p>
        
        <div style="background: #f0f9e8; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #4CAF50;">
          <h3 style="color: #2e7d32; margin-top: 0;">Next Steps</h3>
          <p style="margin: 8px 0; color: #333;">To start accepting payments and go live on Outsyde, you need to complete your Stripe payment setup.</p>
        </div>
        
        ${params.stripeOnboardingUrl ? `
        <div style="text-align: center; margin-top: 30px;">
          <a href="${params.stripeOnboardingUrl}" 
             style="background: #635bff; color: white; padding: 14px 35px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
            Complete Payment Setup
          </a>
        </div>
        ` : `
        <div style="text-align: center; margin-top: 30px;">
          <a href="${getAppBaseUrl()}" 
             style="background: #f5a623; color: white; padding: 14px 35px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
            Go to Dashboard
          </a>
        </div>
        `}
        
        <p style="font-size: 14px; color: #666; margin-top: 30px;">
          Once you complete payment setup, your business will be visible to customers in your area. Start adding your products and services to get discovered!
        </p>
      </div>
      
      <div style="background: #f5f5f5; padding: 15px; text-align: center; color: #666; font-size: 12px;">
        <p>Welcome to the Outsyde family!</p>
      </div>
    </div>
  `;

  const text = `
Congratulations! ${params.businessName} is Approved on Outsyde

Hi ${params.ownerName},

Great news! Your business ${params.businessName} has been approved to join the Outsyde marketplace.

Next Steps:
To start accepting payments and go live on Outsyde, you need to complete your Stripe payment setup.

${params.stripeOnboardingUrl ? `Complete payment setup: ${params.stripeOnboardingUrl}` : `Visit your dashboard: ${getAppBaseUrl()}`}

Once you complete payment setup, your business will be visible to customers in your area.

Welcome to the Outsyde family!
  `;

  return sendAdminEmail({
    to: params.ownerEmail,
    subject,
    html,
    text,
    log: { kind: 'account', label: 'Business approved' },
  });
}

export async function sendVendorRejectionEmail(params: {
  ownerEmail: string;
  ownerName: string;
  businessName: string;
  rejectionReason: string;
}): Promise<boolean> {
  const subject = `Update on Your ${params.businessName} Application`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #666, #888); padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">Application Update</h1>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #333;">Hi ${params.ownerName},</p>
        
        <p style="font-size: 16px; color: #333;">
          Thank you for your interest in joining Outsyde with <strong>${params.businessName}</strong>.
        </p>
        
        <p style="font-size: 16px; color: #333;">
          After careful review, we're unable to approve your application at this time.
        </p>
        
        <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
          <h3 style="color: #856404; margin-top: 0;">Reason</h3>
          <p style="margin: 8px 0; color: #333;">${params.rejectionReason}</p>
        </div>
        
        <p style="font-size: 14px; color: #666; margin-top: 20px;">
          If you believe this decision was made in error or would like to address the concerns mentioned above, please reply to this email or contact our support team.
        </p>
        
        <p style="font-size: 14px; color: #666;">
          You're welcome to reapply once you've addressed the feedback provided.
        </p>
      </div>
      
      <div style="background: #f5f5f5; padding: 15px; text-align: center; color: #666; font-size: 12px;">
        <p>Thank you for considering Outsyde.</p>
      </div>
    </div>
  `;

  const text = `
Update on Your ${params.businessName} Application

Hi ${params.ownerName},

Thank you for your interest in joining Outsyde with ${params.businessName}.

After careful review, we're unable to approve your application at this time.

Reason: ${params.rejectionReason}

If you believe this decision was made in error or would like to address the concerns mentioned above, please reply to this email or contact our support team.

You're welcome to reapply once you've addressed the feedback provided.

Thank you for considering Outsyde.
  `;

  return sendAdminEmail({
    to: params.ownerEmail,
    subject,
    html,
    text,
    log: { kind: 'account', label: 'Business application not approved' },
  });
}

// ─── Booking & Order Transactional Emails ────────────────────────────────────

const BRAND = {
  bg: '#0D0D0D',
  card: '#1A1A1A',
  gold: '#E8B930',
  ctaBg: '#1A3C34',
  ctaText: '#E8B930',
  heading: '#F5F0E8',
  body: '#FFFFFF',
  muted: '#888888',
  border: '#2A2A2A',
} as const;


// `log` is set for emails to customers, vendors and photographers; internal alerts pass none and are
// never logged. Logging never changes what this function returns or throws (PR C2).
async function sendBrandedEmail(to: string, subject: string, html: string, log?: EmailLogTag): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('[emailService] RESEND_API_KEY not set');
  }
  const resend = new Resend(apiKey);
  let result: Awaited<ReturnType<typeof resend.emails.send>>;
  try {
    result = await resend.emails.send({ from: FROM_ORDERS, to, subject, html });
  } catch (err) {
    logTransactionalEmail(log, to, { error: err });
    throw err;
  }
  if (result.error) {
    const errMsg = typeof result.error === 'object' && result.error !== null
      ? (result.error as { message?: string }).message ?? JSON.stringify(result.error)
      : String(result.error);
    logTransactionalEmail(log, to, { error: errMsg });
    throw new Error(`Resend error: ${errMsg}`);
  }
  logTransactionalEmail(log, to, { resendId: result.data?.id });
}

function buildEmailShell(
  heading: string,
  rows: { label: string; value: string }[],
): string {
  const rowsHtml = rows.map(r => `
    <tr>
      <td style="padding:8px 0;color:#888888;font-size:13px;width:38%;vertical-align:top;">${r.label}</td>
      <td style="padding:8px 0;color:#FFFFFF;font-size:14px;vertical-align:top;">${r.value}</td>
    </tr>`).join('');

  return `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#0D0D0D;font-family:'Helvetica Neue',Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D0D;padding:32px 0;">
        <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
            <tr>
              <td style="padding:0 0 4px 0;">
                <div style="background:#1A1A1A;border-radius:10px 10px 0 0;padding:24px 32px;border-bottom:2px solid #E8B930;">
                  <span style="color:#E8B930;font-size:22px;font-weight:800;letter-spacing:1px;">OUTSYDE</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="background:#1A1A1A;border-radius:0 0 10px 10px;padding:32px;">
                <h1 style="color:#F5F0E8;font-size:20px;font-weight:700;margin:0 0 24px 0;">${heading}</h1>
                <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #2A2A2A;">
                  ${rowsHtml}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 0;text-align:center;color:#888888;font-size:12px;">
                This is an automated message from Outsyde. Please do not reply to this email.
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>`;
}

// ─── Rich Email Builder ───────────────────────────────────────────────────────

function cents(n: number): string {
  return `$${(n / 100).toFixed(2)}`;
}

function detailRow(label: string, value: string, odd: boolean): string {
  const bg = odd ? '#1A1A1A' : '#212121';
  return `<tr style="background:${bg};">
    <td style="padding:10px 14px;color:#E8B930;font-size:13px;font-weight:600;width:40%;vertical-align:top;">${label}</td>
    <td style="padding:10px 14px;color:#FFFFFF;font-size:14px;vertical-align:top;">${value}</td>
  </tr>`;
}

export function emailHeader(heading: string, subheading: string): string {
  return `
  <tr>
    <td style="background:#1A1A1A;border-radius:10px 10px 0 0;padding:28px 32px 0;text-align:center;border-bottom:2px solid #E8B930;">
      <div style="color:#E8B930;font-size:28px;font-weight:900;letter-spacing:2px;margin-bottom:6px;">OUTSYDE</div>
      <div style="color:#888888;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-bottom:20px;">Culture meets commerce</div>
    </td>
  </tr>
  <tr>
    <td style="background:#1A1A1A;padding:24px 32px 8px;">
      <h1 style="color:#F5F0E8;font-size:22px;font-weight:800;margin:0 0 8px 0;text-align:center;">${heading}</h1>
      <p style="color:#888888;font-size:14px;margin:0 0 20px 0;text-align:center;">${subheading}</p>
      <div style="border-top:1px solid #2A2A2A;"></div>
    </td>
  </tr>`;
}

export function emailCta(label: string, url: string): string {
  return `<tr>
    <td style="background:#1A1A1A;padding:24px 32px;">
      <div style="text-align:center;">
        <a href="${url}" style="display:inline-block;background:#1A3C34;color:#E8B930;padding:14px 36px;text-decoration:none;border-radius:6px;font-weight:700;font-size:15px;letter-spacing:0.5px;">${label}</a>
      </div>
    </td>
  </tr>`;
}

export function emailFooter(extra?: string): string {
  return `<tr>
    <td style="background:#111111;border-radius:0 0 10px 10px;padding:20px 32px;text-align:center;">
      ${extra ? `<p style="color:#AAAAAA;font-size:13px;margin:0 0 10px 0;">${extra}</p>` : ''}
      <p style="color:#555555;font-size:12px;margin:0 0 4px 0;">For questions contact us at <a href="mailto:info@goutsyde.com" style="color:#E8B930;text-decoration:none;">info@goutsyde.com</a></p>
      <p style="color:#444444;font-size:11px;margin:0;">info@goutsyde.com &nbsp;·&nbsp; Culture meets commerce &nbsp;·&nbsp; Go Outsyde</p>
      <p style="color:#333333;font-size:11px;margin:8px 0 0 0;">Outsyde LLC &nbsp;·&nbsp; 54 State Street, Ste 804 #13315, Albany, New York 12207, US</p>
    </td>
  </tr>`;
}

export function wrapEmail(innerRows: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0D0D0D;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D0D;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        ${innerRows}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ─── 7 Transactional Email Functions ─────────────────────────────────────────

export async function sendAppointmentConfirmationToConsumer(params: {
  toEmail: string;
  consumerName: string;
  vendorName: string;
  vendorContactEmail?: string;
  serviceName: string;
  bookingId: string;
  bookingNumber: number;
  date: string;
  time: string;
  location?: string;
  basePrice: number;
  // Set only when a deposit was charged instead of the full service price.
  depositAmountCents?: number;
  remainderDueCents?: number;
  // Outsyde rewards (points code) taken off what the customer paid now. Outsyde pays it.
  rewardsDiscountCents?: number;
  addons?: Array<{ name: string; priceCents: number }>;
}): Promise<void> {
  try {
    const chargedBase = params.depositAmountCents ?? params.basePrice;
    const consumerUpcharge = chargedBase * 0.08;
    const consumerTotal = chargedBase + consumerUpcharge;
    const rewardsCents = params.rewardsDiscountCents && params.rewardsDiscountCents > 0 ? params.rewardsDiscountCents : 0;
    const paidNow = consumerTotal - rewardsCents;
    const rewardsRows = rewardsCents > 0 ? [{ label: 'Outsyde Rewards', value: `${cents(rewardsCents)} off` }] : [];
    const bookingRef = `#A${String(params.bookingNumber).padStart(4, '0')}`;
    const isDeposit = params.depositAmountCents != null;
    const addonRows = (params.addons ?? []).map((a) =>
      ({ label: `Add-on: ${a.name.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c))}`, value: isDeposit ? `${cents(a.priceCents)} (paid in person)` : cents(a.priceCents) })
    );

    const rows = [
      { label: 'Booking', value: bookingRef },
      { label: 'Service', value: params.serviceName },
      ...addonRows,
      { label: 'Date', value: params.date },
      { label: 'Time', value: params.time },
      ...(params.location ? [{ label: 'Location', value: params.location }] : []),
      ...(isDeposit ? [
        { label: 'Service Total', value: cents(params.basePrice) },
        ...rewardsRows,
        { label: 'Deposit Paid', value: cents(paidNow) },
        { label: 'Due at Appointment', value: cents(params.remainderDueCents ?? 0) },
      ] : [
        ...rewardsRows,
        { label: 'Total Paid', value: cents(paidNow) },
      ]),
    ].map((r, i) => detailRow(r.label, r.value, i % 2 === 0)).join('');

    const contactLines = [
      ...(params.vendorContactEmail ? [`<span style="color:#FFFFFF;">${params.vendorName}:</span> <a href="mailto:${params.vendorContactEmail}" style="color:#E8B930;">${params.vendorContactEmail}</a>`] : []),
      `<span style="color:#FFFFFF;">Outsyde Support:</span> <a href="mailto:info@goutsyde.com" style="color:#E8B930;">info@goutsyde.com</a>`,
    ].map(l => `<li style="margin-bottom:4px;">${l}</li>`).join('');

    const html = wrapEmail(`
      ${emailHeader('You\'re Booked! 🎉', `Your appointment with ${params.vendorName} is confirmed.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">${rows}</table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0 0 6px 0;font-weight:600;">Have questions? Reach out:</p>
        <ul style="margin:0;padding-left:18px;color:#AAAAAA;font-size:13px;line-height:1.8;">${contactLines}</ul>
      </td></tr>
      ${emailCta('View My Bookings', 'https://goutsyde.com/account/bookings')}
      ${emailFooter()}
    `);

    await sendBrandedEmail(params.toEmail, `🎉 Your appointment is confirmed — ${params.serviceName}`, html, { kind: 'booking', label: 'Booking confirmation' });
    console.log(`[Email] Appointment confirmation sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendAppointmentConfirmationToConsumer failed:', err);
    throw err;
  }
}

export async function sendAppointmentNotificationToVendor(params: {
  toEmail: string;
  vendorName: string;
  consumerName: string;
  consumerUsername?: string;
  consumerDisplayName?: string;
  serviceName: string;
  bookingId: string;
  bookingNumber: number;
  date: string;
  time: string;
  location?: string;
  basePrice: number;
  // Set only when a deposit was charged instead of the full service price.
  depositAmountCents?: number;
  remainderDueCents?: number;
  // Outsyde rewards the customer used (paid by Outsyde; the payout is unchanged).
  rewardsDiscountCents?: number;
  addons?: Array<{ name: string; priceCents: number }>;
  customerDetails?: string | null;
}): Promise<void> {
  try {
    const chargedBase = params.depositAmountCents ?? params.basePrice;
    const vendorFee = chargedBase * 0.02;
    const vendorPayout = chargedBase - vendorFee;
    const rewardsCents = params.rewardsDiscountCents && params.rewardsDiscountCents > 0 ? params.rewardsDiscountCents : 0;
    const bookingRef = `#A${String(params.bookingNumber).padStart(4, '0')}`;
    const isDeposit = params.depositAmountCents != null;

    const customerDisplay = params.consumerDisplayName || params.consumerName;
    const usernameDisplay = params.consumerUsername ? `@${params.consumerUsername}` : '';

    const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
    const addonRows = (params.addons ?? []).map((a) =>
      ({ label: `Add-on: ${esc(a.name)}`, value: isDeposit ? `${cents(a.priceCents)} (paid in person)` : cents(a.priceCents) })
    );

    const rows = [
      { label: 'Booking', value: bookingRef },
      { label: 'Customer Name', value: customerDisplay },
      ...(usernameDisplay ? [{ label: 'Customer Username', value: usernameDisplay }] : []),
      { label: 'Service', value: params.serviceName },
      ...addonRows,
      { label: 'Date', value: params.date },
      { label: 'Time', value: params.time },
      ...(params.location ? [{ label: 'Location', value: params.location }] : []),
      ...(isDeposit ? [
        { label: 'Service Total', value: cents(params.basePrice) },
        { label: 'Deposit Collected', value: cents(chargedBase) },
        { label: 'Your Deposit Payout', value: cents(vendorPayout) },
        { label: 'Balance to Collect in Person', value: cents(params.remainderDueCents ?? 0) },
      ] : [
        { label: 'Your Payout', value: cents(vendorPayout) },
      ]),
      ...(rewardsCents > 0 ? [{ label: 'Outsyde Rewards Used', value: `${cents(rewardsCents)}, paid by Outsyde. Your payout is unchanged.` }] : []),
    ].map((r, i) => detailRow(r.label, r.value, i % 2 === 0)).join('');

    const customerDetailsBlock = params.customerDetails
      ? `<tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
          <p style="color:#E8B930;font-size:12px;margin:0 0 4px 0;font-weight:600;">Customer Details:</p>
          <p style="color:#CCCCCC;font-size:13px;margin:0;white-space:pre-wrap;">${esc(params.customerDetails)}</p>
        </td></tr>`
      : '';

    const html = wrapEmail(`
      ${emailHeader('New Booking Received! 🎉', 'Congratulations! You have a new appointment booking.')}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">${rows}</table>
      </td></tr>
      ${customerDetailsBlock}
      <tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
        <p style="color:#555555;font-size:12px;margin:0;">Outsyde platform fee: 2% (${cents(vendorFee)})</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);

    await sendBrandedEmail(params.toEmail, `🎉 New booking received — ${params.serviceName}`, html, { kind: 'booking', label: 'New booking (vendor)' });
    console.log(`[Email] Appointment vendor notification sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendAppointmentNotificationToVendor failed:', err);
    throw err;
  }
}

export async function sendShootBookingConfirmationToConsumer(params: {
  toEmail: string;
  consumerName: string;
  photographerName: string;
  photographerContactEmail?: string;
  shootType: string;
  bookingId: string;
  bookingNumber: number;
  date: string;
  time: string;
  location?: string;
  basePrice: number;
  // Set only when a deposit was charged instead of the full service price.
  depositAmountCents?: number;
  remainderDueCents?: number;
  // Outsyde rewards (points code) taken off what the customer paid now. Outsyde pays it.
  rewardsDiscountCents?: number;
  addons?: Array<{ name: string; priceCents: number }>;
  customerDetails?: string | null;
}): Promise<void> {
  try {
    const chargedBase = params.depositAmountCents ?? params.basePrice;
    const consumerUpcharge = chargedBase * 0.08;
    const consumerTotal = chargedBase + consumerUpcharge;
    const rewardsCents = params.rewardsDiscountCents && params.rewardsDiscountCents > 0 ? params.rewardsDiscountCents : 0;
    const paidNow = consumerTotal - rewardsCents;
    const rewardsRows = rewardsCents > 0 ? [{ label: 'Outsyde Rewards', value: `${cents(rewardsCents)} off` }] : [];
    const bookingRef = `#S${String(params.bookingNumber).padStart(4, '0')}`;
    const isDeposit = params.depositAmountCents != null;
    const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
    const addonRows = (params.addons ?? []).map((a) =>
      ({ label: `Add-on: ${esc(a.name)}`, value: isDeposit ? `${cents(a.priceCents)} (paid in person)` : cents(a.priceCents) })
    );

    const rows = [
      { label: 'Booking', value: bookingRef },
      { label: 'Shoot Type', value: params.shootType },
      { label: 'Photographer', value: params.photographerName },
      { label: 'Date', value: params.date },
      { label: 'Time', value: params.time },
      ...(params.location ? [{ label: 'Location', value: params.location }] : []),
      ...addonRows,
      ...(isDeposit ? [
        { label: 'Service Total', value: cents(params.basePrice) },
        ...rewardsRows,
        { label: 'Deposit Paid', value: cents(paidNow) },
        { label: 'Due at Appointment', value: cents(params.remainderDueCents ?? 0) },
      ] : [
        ...rewardsRows,
        { label: 'Total Paid', value: cents(paidNow) },
      ]),
    ].map((r, i) => detailRow(r.label, r.value, i % 2 === 0)).join('');

    const customerDetailsBlock = params.customerDetails
      ? `<tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
          <p style="color:#E8B930;font-size:12px;margin:0 0 4px 0;font-weight:600;">Customer Details:</p>
          <p style="color:#CCCCCC;font-size:13px;margin:0;white-space:pre-wrap;">${esc(params.customerDetails)}</p>
        </td></tr>`
      : '';

    const contactLines = [
      ...(params.photographerContactEmail ? [`<span style="color:#FFFFFF;">${params.photographerName}:</span> <a href="mailto:${params.photographerContactEmail}" style="color:#E8B930;">${params.photographerContactEmail}</a>`] : []),
      `<span style="color:#FFFFFF;">Outsyde Support:</span> <a href="mailto:info@goutsyde.com" style="color:#E8B930;">info@goutsyde.com</a>`,
    ].map(l => `<li style="margin-bottom:4px;">${l}</li>`).join('');

    const html = wrapEmail(`
      ${emailHeader('Shoot Booked! 🎉', `Your session with ${params.photographerName} is locked in.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">${rows}</table>
      </td></tr>
      ${customerDetailsBlock}
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0 0 6px 0;font-weight:600;">Have questions? Reach out:</p>
        <ul style="margin:0;padding-left:18px;color:#AAAAAA;font-size:13px;line-height:1.8;">${contactLines}</ul>
      </td></tr>
      ${emailCta('View My Bookings', 'https://goutsyde.com/account/bookings')}
      ${emailFooter()}
    `);

    await sendBrandedEmail(params.toEmail, `🎉 Your shoot is confirmed — ${params.shootType}`, html, { kind: 'shoot', label: 'Shoot booking confirmation' });
    console.log(`[Email] Shoot confirmation sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendShootBookingConfirmationToConsumer failed:', err);
    throw err;
  }
}

export async function sendShootBookingNotificationToPhotographer(params: {
  toEmail: string;
  photographerName: string;
  consumerName: string;
  consumerUsername?: string;
  consumerDisplayName?: string;
  shootType: string;
  bookingId: string;
  bookingNumber: number;
  date: string;
  time: string;
  location?: string;
  basePrice: number;
  // Set only when a deposit was charged instead of the full service price.
  depositAmountCents?: number;
  remainderDueCents?: number;
  // Outsyde rewards the customer used (paid by Outsyde; the payout is unchanged).
  rewardsDiscountCents?: number;
  addons?: Array<{ name: string; priceCents: number }>;
  customerDetails?: string | null;
}): Promise<void> {
  try {
    const chargedBase = params.depositAmountCents ?? params.basePrice;
    const vendorFee = chargedBase * 0.02;
    const vendorPayout = chargedBase - vendorFee;
    const rewardsCents = params.rewardsDiscountCents && params.rewardsDiscountCents > 0 ? params.rewardsDiscountCents : 0;
    const bookingRef = `#S${String(params.bookingNumber).padStart(4, '0')}`;
    const isDeposit = params.depositAmountCents != null;

    const clientDisplay = params.consumerDisplayName || params.consumerName;
    const usernameDisplay = params.consumerUsername ? `@${params.consumerUsername}` : '';
    const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
    const addonRows = (params.addons ?? []).map((a) =>
      ({ label: `Add-on: ${esc(a.name)}`, value: isDeposit ? `${cents(a.priceCents)} (paid in person)` : cents(a.priceCents) })
    );

    const rows = [
      { label: 'Booking', value: bookingRef },
      { label: 'Client Name', value: clientDisplay },
      ...(usernameDisplay ? [{ label: 'Client Username', value: usernameDisplay }] : []),
      { label: 'Shoot Type', value: params.shootType },
      { label: 'Date', value: params.date },
      { label: 'Time', value: params.time },
      ...(params.location ? [{ label: 'Location', value: params.location }] : []),
      ...addonRows,
      ...(isDeposit ? [
        { label: 'Service Total', value: cents(params.basePrice) },
        { label: 'Deposit Collected', value: cents(chargedBase) },
        { label: 'Your Deposit Payout', value: cents(vendorPayout) },
        { label: 'Balance to Collect in Person', value: cents(params.remainderDueCents ?? 0) },
      ] : [
        { label: 'Your Payout', value: cents(vendorPayout) },
      ]),
      ...(rewardsCents > 0 ? [{ label: 'Outsyde Rewards Used', value: `${cents(rewardsCents)}, paid by Outsyde. Your payout is unchanged.` }] : []),
    ].map((r, i) => detailRow(r.label, r.value, i % 2 === 0)).join('');

    const customerDetailsBlock = params.customerDetails
      ? `<tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
          <p style="color:#E8B930;font-size:12px;margin:0 0 4px 0;font-weight:600;">Customer Details:</p>
          <p style="color:#CCCCCC;font-size:13px;margin:0;white-space:pre-wrap;">${esc(params.customerDetails)}</p>
        </td></tr>`
      : '';

    const html = wrapEmail(`
      ${emailHeader('New Shoot Booking! 🎉', 'Congratulations! You have a new shoot booking.')}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">${rows}</table>
      </td></tr>
      ${customerDetailsBlock}
      <tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
        <p style="color:#555555;font-size:12px;margin:0;">Outsyde platform fee: 2% (${cents(vendorFee)})</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);

    await sendBrandedEmail(params.toEmail, `🎉 New shoot booked — ${params.shootType}`, html, { kind: 'shoot', label: 'New shoot booking (photographer)' });
    console.log(`[Email] Shoot photographer notification sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendShootBookingNotificationToPhotographer failed:', err);
    throw err;
  }
}

export async function sendShootBookingAcceptedToPhotographer(params: {
  toEmail: string;
  photographerName: string;
  consumerName: string;
  shootType: string;
  bookingId: string;
  bookingNumber: number;
  date: string;
  time: string;
}): Promise<void> {
  try {
    const bookingRef = `#S${String(params.bookingNumber).padStart(4, '0')}`;
    const html = wrapEmail(`
      ${emailHeader('Booking Confirmed ✅', `You confirmed the shoot with ${params.consumerName}.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Booking', bookingRef, true)}
          ${detailRow('Client', params.consumerName, false)}
          ${detailRow('Shoot Type', params.shootType, true)}
          ${detailRow('Date', params.date, false)}
          ${detailRow('Time', params.time, true)}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
        <p style="color:#888888;font-size:13px;margin:0;">Payment will be transferred to your account after the session.</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Booking Confirmed — ${params.consumerName}`, html, { kind: 'shoot', label: 'Shoot accepted (photographer)' });
    console.log(`[Email] Shoot booking accepted confirmation sent to photographer ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendShootBookingAcceptedToPhotographer failed:', err);
  }
}

export async function sendShootBookingDeclinedToPhotographer(params: {
  toEmail: string;
  photographerName: string;
  consumerName: string;
  shootType: string;
  bookingId: string;
  bookingNumber: number;
  date: string;
  reason?: string;
}): Promise<void> {
  try {
    const bookingRef = `#S${String(params.bookingNumber).padStart(4, '0')}`;
    const html = wrapEmail(`
      ${emailHeader('Booking Declined', `You declined the request from ${params.consumerName}.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Booking', bookingRef, true)}
          ${detailRow('Client', params.consumerName, false)}
          ${detailRow('Shoot Type', params.shootType, true)}
          ${detailRow('Date', params.date, false)}
          ${params.reason ? detailRow('Reason', params.reason, true) : ''}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0;">The client has not been charged. The time slot has been released.</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Booking Declined — ${params.consumerName}`, html, { kind: 'shoot', label: 'Shoot declined (photographer)' });
    console.log(`[Email] Shoot booking declined confirmation sent to photographer ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendShootBookingDeclinedToPhotographer failed:', err);
  }
}

export async function sendShootBookingCanceledToPhotographer(params: {
  toEmail: string;
  photographerName: string;
  consumerName: string;
  shootType: string;
  bookingId: string;
  bookingNumber: number;
  date: string;
  time: string;
}): Promise<void> {
  try {
    const bookingRef = `#S${String(params.bookingNumber).padStart(4, '0')}`;
    const html = wrapEmail(`
      ${emailHeader('Booking Canceled', `${params.consumerName} has canceled their session with you.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Booking', bookingRef, true)}
          ${detailRow('Client', params.consumerName, false)}
          ${detailRow('Shoot Type', params.shootType, true)}
          ${detailRow('Date', params.date, false)}
          ${detailRow('Time', params.time, true)}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0;">The slot has been released and is now available for new bookings.</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Your Booking Was Canceled — ${params.consumerName}`, html, { kind: 'shoot', label: 'Shoot canceled (photographer)' });
    console.log(`[Email] Shoot booking canceled notification sent to photographer ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendShootBookingCanceledToPhotographer failed:', err);
  }
}

export async function sendShootBookingExpiredToPhotographer(params: {
  toEmail: string;
  photographerName: string;
  shootType: string;
  bookingId: string;
  date: string;
}): Promise<void> {
  try {
    const html = wrapEmail(`
      ${emailHeader('Booking Request Expired', 'A booking request was not responded to in time.')}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Shoot Type', params.shootType, true)}
          ${detailRow('Date', params.date, false)}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0;">The client was not charged. The time slot has been released automatically.</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Booking Request Expired`, html, { kind: 'shoot', label: 'Shoot request expired (photographer)' });
    console.log(`[Email] Shoot booking expiry notification sent to photographer ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendShootBookingExpiredToPhotographer failed:', err);
  }
}

export async function sendPhotographerWelcomeEmail(toEmail: string, displayName: string): Promise<void> {
  try {
    const html = wrapEmail(`
      ${emailHeader('Welcome to Outsyde! 📸', `You're almost ready to start shooting, ${displayName}.`)}
      <tr><td style="background:#1A1A1A;padding:20px 32px 8px;">
        <p style="color:#AAAAAA;font-size:14px;line-height:1.7;margin:0 0 14px 0;">
          Your photographer profile has been created. The next step is connecting your Stripe account so you can accept bookings and receive payouts directly.
        </p>
        <p style="color:#AAAAAA;font-size:14px;line-height:1.7;margin:0 0 14px 0;">
          Once connected, your profile will go live and clients will be able to book sessions with you through the Outsyde platform.
        </p>
        <p style="color:#666666;font-size:13px;margin:0;">Head to your dashboard to connect Stripe and complete your setup.</p>
      </td></tr>
      ${emailCta('Go to My Dashboard', 'https://www.goutsyde.com/photographer-dashboard')}
      ${emailFooter('Welcome to the Outsyde community — we\'re glad to have you.')}
    `);
    await sendBrandedEmail(toEmail, `Welcome to Outsyde — you're almost ready to shoot`, html, { kind: 'account', label: 'Photographer welcome' });
    console.log(`[Email] Photographer welcome email sent to ${toEmail}`);
  } catch (err) {
    console.error('[Email] sendPhotographerWelcomeEmail failed:', err);
  }
}

export async function sendOrderConfirmationToConsumer(params: {
  toEmail: string;
  consumerName: string;
  orderId: string;
  orderNumber: number;
  items: Array<{
    productName: string;
    variantLabel?: string;
    vendorName: string;
    vendorContactEmail?: string;
    quantity: number;
    basePrice: number;
  }>;
  // Pre-computed amounts from the DB orders row — preferred over recomputing from basePrice.
  totalAmountCents?: number;
  platformFeeCents?: number;
  // Outsyde rewards (points code) taken off the charge. Outsyde pays it.
  rewardsDiscountCents?: number;
}): Promise<void> {
  try {
    const orderRef = `#${String(params.orderNumber).padStart(4, '0')}`;

    const itemCards = params.items.map(item => {
      const itemBase = item.basePrice * item.quantity;
      return `<tr style="background:#1E1E1E;">
        <td style="padding:12px 14px;border-bottom:1px solid #2A2A2A;">
          <div style="color:#FFFFFF;font-size:14px;font-weight:600;">${item.productName}</div>
          ${item.variantLabel ? `<div style="color:#E8B930;font-size:12px;margin-top:2px;">${item.variantLabel}</div>` : ''}
          <div style="color:#888888;font-size:12px;margin-top:2px;">by ${item.vendorName} &nbsp;·&nbsp; Qty: ${item.quantity} &nbsp;·&nbsp; ${cents(itemBase)}</div>
        </td>
      </tr>`;
    }).join('');

    // Use stored DB totals when available; fall back to recomputing for backward compat.
    const hasTotals = typeof params.totalAmountCents === 'number' && typeof params.platformFeeCents === 'number';
    let totalRows: string;
    if (hasTotals) {
      const subtotalCents = params.totalAmountCents! - params.platformFeeCents!;
      const rewardsCents = params.rewardsDiscountCents && params.rewardsDiscountCents > 0 ? params.rewardsDiscountCents : 0;
      totalRows = `
        ${detailRow('Subtotal', cents(subtotalCents), true)}
        ${detailRow('Outsyde fee', cents(params.platformFeeCents!), false)}
        ${rewardsCents > 0 ? detailRow('Outsyde Rewards', `${cents(rewardsCents)} off`, true) : ''}
        ${detailRow('Total charged', cents(params.totalAmountCents! - rewardsCents), rewardsCents > 0 ? false : true)}
      `;
    } else {
      let computed = 0;
      params.items.forEach(i => { computed += i.basePrice * i.quantity * 1.08; });
      totalRows = detailRow('Order Total', cents(computed), true);
    }

    const contactLines = [
      ...Array.from(new Map(params.items
        .filter(i => i.vendorContactEmail)
        .map(i => [i.vendorName, i.vendorContactEmail!])
      ).entries()).map(([name, email]) =>
        `<span style="color:#FFFFFF;">${name}:</span> <a href="mailto:${email}" style="color:#E8B930;">${email}</a>`
      ),
      `<span style="color:#FFFFFF;">Outsyde Support:</span> <a href="mailto:info@goutsyde.com" style="color:#E8B930;">info@goutsyde.com</a>`,
    ].map(l => `<li style="margin-bottom:4px;">${l}</li>`).join('');

    const html = wrapEmail(`
      ${emailHeader('Order Confirmed! 🎉', 'Thanks for your purchase. Here\'s your order summary.')}
      <tr><td style="background:#1A1A1A;padding:0 32px 8px;">
        <p style="color:#888888;font-size:12px;margin:0 0 8px 0;">Order ${orderRef}</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;border:1px solid #2A2A2A;">${itemCards}</table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
          ${totalRows}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0 0 6px 0;font-weight:600;">Questions about your order? Contact:</p>
        <ul style="margin:0;padding-left:18px;color:#AAAAAA;font-size:13px;line-height:1.8;">${contactLines}</ul>
      </td></tr>
      ${emailCta('View My Orders', 'https://goutsyde.com/account/orders')}
      ${emailFooter()}
    `);

    const subjectItem = params.items.length > 1 ? `${params.items.length} items` : params.items[0]?.productName || 'your order';
    await sendBrandedEmail(params.toEmail, `🎉 Order confirmed — ${subjectItem}`, html, { kind: 'order', label: 'Order confirmation' });
    console.log(`[Email] Order confirmation sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendOrderConfirmationToConsumer failed:', err);
    throw err;
  }
}

export async function sendOrderNotificationToVendor(params: {
  toEmail: string;
  vendorName: string;
  consumerName: string;
  consumerUsername?: string;
  consumerDisplayName?: string;
  orderId: string;
  orderNumber: number;
  items: Array<{
    productName: string;
    variantLabel?: string;
    quantity: number;
    basePrice: number;
  }>;
  // Pre-computed payout from the DB orders.vendorNet column — preferred over recomputing.
  vendorNetCents?: number;
  // Outsyde rewards the customer used (paid by Outsyde; the payout is unchanged).
  rewardsDiscountCents?: number;
}): Promise<void> {
  try {
    const orderRef = `#${String(params.orderNumber).padStart(4, '0')}`;
    const customerDisplay = params.consumerDisplayName || params.consumerName;
    const usernameDisplay = params.consumerUsername ? `@${params.consumerUsername}` : '';

    let computedPayout = 0;
    const itemRows = params.items.map((item, i) => {
      const itemBase = item.basePrice * item.quantity;
      computedPayout += itemBase;
      const bg = i % 2 === 0 ? '#1A1A1A' : '#212121';
      const nameCell = item.variantLabel
        ? `${item.productName}<br/><span style="color:#888888;font-size:12px;">${item.variantLabel}</span>`
        : item.productName;
      return `<tr style="background:${bg};">
        <td style="padding:10px 14px;color:#FFFFFF;font-size:13px;">${nameCell}</td>
        <td style="padding:10px 14px;color:#888888;font-size:13px;text-align:center;">${item.quantity}</td>
        <td style="padding:10px 14px;color:#E8B930;font-size:13px;text-align:right;">${cents(itemBase)}</td>
      </tr>`;
    }).join('');

    // Use the stored DB vendor net when available; fall back to computed for backward compat.
    const totalPayout = typeof params.vendorNetCents === 'number'
      ? params.vendorNetCents
      : computedPayout * 0.98;

    const html = wrapEmail(`
      ${emailHeader('You Made a Sale! 🎉', 'Congratulations! Here\'s what was ordered.')}
      <tr><td style="background:#1A1A1A;padding:0 32px 8px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
          ${detailRow('Customer', customerDisplay, true)}
          ${usernameDisplay ? detailRow('Username', usernameDisplay, false) : ''}
          ${detailRow('Order ID', orderRef, usernameDisplay ? true : false)}
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;border:1px solid #2A2A2A;">
          <tr style="background:#252525;">
            <th style="padding:8px 14px;color:#E8B930;font-size:12px;text-align:left;font-weight:600;">Product</th>
            <th style="padding:8px 14px;color:#E8B930;font-size:12px;text-align:center;font-weight:600;">Qty</th>
            <th style="padding:8px 14px;color:#E8B930;font-size:12px;text-align:right;font-weight:600;">Item Total</th>
          </tr>
          ${itemRows}
          <tr style="background:#1E2E2A;">
            <td colspan="2" style="padding:10px 14px;color:#E8B930;font-size:14px;font-weight:700;">Your Payout</td>
            <td style="padding:10px 14px;color:#E8B930;font-size:14px;font-weight:700;text-align:right;">${cents(totalPayout)}</td>
          </tr>
        </table>
        <p style="color:#555555;font-size:12px;margin:8px 0 0 0;">Outsyde platform fee deducted from payout</p>
        ${params.rewardsDiscountCents && params.rewardsDiscountCents > 0 ? `<p style="color:#E8B930;font-size:12px;margin:6px 0 0 0;">The customer used ${cents(params.rewardsDiscountCents)} in Outsyde Rewards, paid by Outsyde. Your payout is unchanged.</p>` : ''}
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/orders')}
      ${emailFooter()}
    `);

    const subjectItem = params.items[0]?.productName || 'an item';
    const subjectSuffix = params.items.length > 1 ? ' + more' : '';
    await sendBrandedEmail(params.toEmail, `🎉 New order received — ${subjectItem}${subjectSuffix}`, html, { kind: 'order', label: 'New order (vendor)' });
    console.log(`[Email] Order vendor notification sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendOrderNotificationToVendor failed:', err);
    throw err;
  }
}

export async function sendInternalEventAlert(params: {
  eventType: 'appointment_booking' | 'shoot_booking' | 'product_order';
  bookingOrOrderId: string;
  consumerName: string;
  consumerEmail: string;
  vendorName: string;
  vendorEmail: string;
  items?: Array<{ productName: string; quantity: number; basePrice: number }>;
  basePrice?: number;
  date?: string;
  time?: string;
  location?: string;
  // Pre-fee amount actually charged (D for a deposit, B for full pay). Fee
  // lines below are computed on this, never on the full service price.
  amountChargedCents?: number;
  paymentType?: 'deposit' | 'full';
  serviceTotalCents?: number;
  // PaymentIntent amount as Stripe recorded it, shown for reconciliation.
  stripeChargeCents?: number;
  // Points code value taken off the charge (Outsyde pays it).
  rewardsDiscountCents?: number;
}): Promise<void> {
  try {
    const totalBase = params.amountChargedCents
      ?? params.basePrice
      ?? (params.items?.reduce((s, i) => s + i.basePrice * i.quantity, 0) ?? 0);
    const isDeposit = params.paymentType === 'deposit';
    const consumerUpcharge = totalBase * 0.08;
    const consumerTotal = totalBase + consumerUpcharge;
    const vendorFee = totalBase * 0.02;
    const vendorPayout = totalBase - vendorFee;
    const outsydeProfit = consumerUpcharge + vendorFee;

    const partiesRows = [
      detailRow('Consumer', `${params.consumerName} / ${params.consumerEmail}`, true),
      detailRow('Vendor', `${params.vendorName} / ${params.vendorEmail}`, false),
      ...(params.date ? [detailRow('Date', params.date, true)] : []),
      ...(params.time ? [detailRow('Time', params.time, false)] : []),
      ...(params.location ? [detailRow('Location', params.location, true)] : []),
      ...(params.paymentType ? [detailRow('Payment Type', isDeposit ? 'Deposit' : 'Full payment', false)] : []),
      ...(isDeposit && params.serviceTotalCents != null ? [
        detailRow('Service Total', cents(params.serviceTotalCents), true),
        detailRow('Due at Appointment (in person, no fee)', cents(Math.max(0, params.serviceTotalCents - totalBase)), false),
      ] : []),
      ...(params.stripeChargeCents != null ? [detailRow('Stripe Charge (actual)', cents(params.stripeChargeCents), true)] : []),
      ...(params.rewardsDiscountCents && params.rewardsDiscountCents > 0
        ? [detailRow('Outsyde Rewards Redeemed (paid by Outsyde)', cents(params.rewardsDiscountCents), false)] : []),
    ].join('');

    let itemBreakdown = '';
    if (params.items && params.items.length > 0) {
      const itemRows = params.items.map((item, i) => {
        const itemBase = item.basePrice * item.quantity;
        const bg = i % 2 === 0 ? '#1A1A1A' : '#212121';
        return `<tr style="background:${bg};">
          <td style="padding:8px 14px;color:#FFFFFF;font-size:13px;">${item.productName} x${item.quantity}</td>
          <td style="padding:8px 14px;color:#888888;font-size:13px;text-align:right;">${cents(itemBase)}</td>
        </tr>`;
      }).join('');
      itemBreakdown = `<tr><td style="background:#1A1A1A;padding:8px 32px 0;">
        <p style="color:#888888;font-size:12px;font-weight:600;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:1px;">Items</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:4px;overflow:hidden;">${itemRows}</table>
      </td></tr>`;
    }

    const financialRows = [
      detailRow(isDeposit ? 'Deposit Amount' : 'Base Amount', cents(totalBase), true),
      detailRow('Consumer Upcharge (8%)', `+${cents(consumerUpcharge)}`, false),
      detailRow('Consumer Total Paid', cents(consumerTotal), true),
      detailRow('Vendor Fee (2%)', `-${cents(vendorFee)}`, false),
      detailRow('Vendor Payout', cents(vendorPayout), true),
    ].join('');

    const html = wrapEmail(`
      <tr>
        <td style="background:#1A1A1A;border-radius:10px 10px 0 0;padding:20px 32px;border-bottom:2px solid #E8B930;">
          <div style="color:#E8B930;font-size:20px;font-weight:900;letter-spacing:2px;">OUTSYDE</div>
          <h1 style="color:#F5F0E8;font-size:18px;font-weight:700;margin:8px 0 0 0;">Transaction Summary</h1>
          <p style="color:#888888;font-size:12px;margin:4px 0 0 0;">${params.eventType} · ${params.bookingOrOrderId}</p>
        </td>
      </tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px 0;">
        <p style="color:#888888;font-size:12px;font-weight:600;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:1px;">Parties</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:4px;overflow:hidden;">${partiesRows}</table>
      </td></tr>
      ${itemBreakdown}
      <tr><td style="background:#1A1A1A;padding:16px 32px 0;">
        <p style="color:#888888;font-size:12px;font-weight:600;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:1px;">Financial Breakdown</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:4px;overflow:hidden;">
          ${financialRows}
          <tr style="background:#1A3C34;">
            <td style="padding:12px 14px;color:#E8B930;font-size:14px;font-weight:800;">Outsyde Profit</td>
            <td style="padding:12px 14px;color:#E8B930;font-size:14px;font-weight:800;text-align:right;">${cents(outsydeProfit)}</td>
          </tr>
          <tr style="background:#141414;">
            <td style="padding:8px 14px 8px 28px;color:#888888;font-size:12px;">From upcharge</td>
            <td style="padding:8px 14px;color:#888888;font-size:12px;text-align:right;">${cents(consumerUpcharge)}</td>
          </tr>
          <tr style="background:#141414;">
            <td style="padding:8px 14px 12px 28px;color:#888888;font-size:12px;">From vendor fee</td>
            <td style="padding:8px 14px 12px;color:#888888;font-size:12px;text-align:right;">${cents(vendorFee)}</td>
          </tr>
        </table>
      </td></tr>
      ${emailFooter()}
    `);

    await sendBrandedEmail(ADMIN_NOTIFICATION_EMAIL, `[Outsyde] ${params.eventType} — ${params.bookingOrOrderId}${isDeposit ? ' (deposit)' : ''}`, html);
    console.log(`[Email] Internal alert sent for: ${params.eventType} ${params.bookingOrOrderId}`);
  } catch (err) {
    console.error('[Email] sendInternalEventAlert failed:', err);
    throw err;
  }
}

export async function sendOrderShippedEmail(params: {
  toEmail: string;
  consumerName: string;
  vendorName: string;
  productName: string;
  orderId: string;
  orderNumber: number;
  carrier: string;
  trackingNumber: string;
  trackingUrl: string;
}): Promise<void> {
  try {
    const subject = `Your order from ${params.vendorName} has shipped!`;
    const orderRef = `#${String(params.orderNumber).padStart(4, '0')}`;
    const html = wrapEmail(`
      ${emailHeader('Your Order Has Shipped 📦', `${params.vendorName} is on the way`)}
      <tr><td style="background:#1A1A1A;padding:24px 32px;">
        <p style="color:#F5F0E8;font-size:15px;margin:0 0 16px 0;">Hi ${params.consumerName},</p>
        <p style="color:#CCCCCC;font-size:14px;margin:0 0 24px 0;">
          Great news! <strong style="color:#F5F0E8;">${params.vendorName}</strong> has shipped your order of
          <strong style="color:#F5F0E8;">${params.productName}</strong>.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;margin-bottom:24px;">
          ${detailRow('Order', orderRef, true)}
          ${detailRow('Carrier', params.carrier, false)}
          ${detailRow('Tracking #', `<span style="font-family:monospace;">${params.trackingNumber}</span>`, true)}
        </table>
      </td></tr>
      ${emailCta('Track My Package', params.trackingUrl)}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, subject, html, { kind: 'order', label: 'Order shipped' });
    console.log(`[Email] Order shipped email sent to ${params.toEmail} for order ${params.orderId}`);
  } catch (err) {
    console.error('[Email] sendOrderShippedEmail failed:', err);
  }
}

export async function sendCancellationAdminEmail(params: {
  adminEmail: string;
  eventType: 'appointment_canceled' | 'shoot_booking_canceled' | 'appointment_refunded' | 'shoot_booking_refunded' | 'order_canceled' | 'refund_approved';
  consumerName: string;
  providerName: string;
  amountCents: number;
  referenceId: string;
  reason?: string;
}): Promise<void> {
  const eventLabels: Record<typeof params.eventType, string> = {
    appointment_canceled: 'Appointment Canceled',
    shoot_booking_canceled: 'Shoot Booking Canceled',
    appointment_refunded: 'Appointment Refunded',
    shoot_booking_refunded: 'Shoot Booking Refunded',
    order_canceled: 'Order Canceled',
    refund_approved: 'Refund Approved',
  };

  const label = eventLabels[params.eventType];
  const subject = `[Outsyde Admin] ${label} — ${params.consumerName}`;
  const formattedAmount = (params.amountCents / 100).toFixed(2);

  const html = wrapEmail(`
    ${emailHeader(label, `Admin Alert — Action by ${params.consumerName}`)}
    <tr><td style="background:#1A1A1A;padding:24px 32px;">
      <p style="color:#F5F0E8;font-size:15px;margin:0 0 16px 0;">A cancellation or refund event just occurred on Outsyde.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
        ${detailRow('Event', label, true)}
        ${detailRow('Customer', params.consumerName, false)}
        ${detailRow('Provider / Business', params.providerName, true)}
        ${detailRow('Refund Amount', `$${formattedAmount}`, false)}
        ${detailRow('Reference ID', params.referenceId.slice(0, 16), true)}
        ${params.reason ? detailRow('Reason', params.reason, false) : ''}
      </table>
    </td></tr>
    ${emailCta('Open Admin Dashboard', `${getAppBaseUrl()}/admin`)}
    ${emailFooter('This is an automated admin alert from Outsyde.')}
  `);

  await sendAdminEmail({ to: ADMIN_NOTIFICATION_EMAIL, subject, html });
}

// ============================================================
// MANUAL BOOKING (PENDING_PROVIDER) EMAIL FUNCTIONS
// ============================================================

export async function sendBookingRequestReceivedToConsumer(params: {
  toEmail: string;
  consumerName: string;
  vendorName: string;
  serviceName: string;
  bookingId: string;
  date: string;
  time: string;
  expiresAt: Date;
  /** IANA zone the deadline is shown in (Part C). Defaults to America/New_York. */
  timeZone?: string;
}): Promise<void> {
  try {
    const expiryStr = params.expiresAt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: params.timeZone || 'America/New_York', timeZoneName: 'short' });
    const html = wrapEmail(`
      ${emailHeader('Booking Request Received', `Your request for ${params.vendorName} is awaiting approval.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Service', params.serviceName, true)}
          ${detailRow('Date', params.date, false)}
          ${detailRow('Time', params.time, true)}
          ${detailRow('Expires', expiryStr, false)}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0;">Your card has been authorized but <strong style="color:#F5F0E8;">not yet charged</strong>. You will only be charged if the business accepts your request. If they decline or don't respond in time, the hold is released automatically.</p>
      </td></tr>
      ${emailCta('View My Bookings', 'https://goutsyde.com/account/bookings')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Booking request received: ${params.serviceName}`, html, { kind: 'booking', label: 'Booking request received' });
  } catch (err) {
    console.error('[Email] sendBookingRequestReceivedToConsumer failed:', err);
  }
}

export async function sendBookingRequestToVendor(params: {
  toEmail: string;
  vendorName: string;
  consumerName: string;
  consumerUsername?: string;
  serviceName: string;
  bookingId: string;
  date: string;
  time: string;
  basePrice: number;
  expiresAt: Date;
  /** IANA zone the deadline is shown in (Part C). Defaults to America/New_York. */
  timeZone?: string;
}): Promise<void> {
  try {
    const vendorFee = params.basePrice * 0.02;
    const vendorPayout = params.basePrice - vendorFee;
    const expiryStr = params.expiresAt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: params.timeZone || 'America/New_York', timeZoneName: 'short' });
    const usernameDisplay = params.consumerUsername ? ` (@${params.consumerUsername})` : '';
    const html = wrapEmail(`
      ${emailHeader('New Booking Request! 📋', `${params.consumerName}${usernameDisplay} wants to book ${params.serviceName}.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Customer', params.consumerName + usernameDisplay, true)}
          ${detailRow('Service', params.serviceName, false)}
          ${detailRow('Date', params.date, true)}
          ${detailRow('Time', params.time, false)}
          ${detailRow('Your Payout', cents(vendorPayout), true)}
          ${detailRow('Respond By', expiryStr, false)}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
        <p style="color:#888888;font-size:13px;margin:0;">Accept or decline in your dashboard. If you don't respond by <strong style="color:#F5F0E8;">${expiryStr}</strong>, the request will expire automatically and the customer will not be charged.</p>
      </td></tr>
      ${emailCta('Review in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `New booking request: ${params.serviceName} on ${params.date}`, html, { kind: 'booking', label: 'New booking request (vendor)' });
  } catch (err) {
    console.error('[Email] sendBookingRequestToVendor failed:', err);
  }
}

export async function sendBookingAcceptedToConsumer(params: {
  toEmail: string;
  consumerName: string;
  vendorName: string;
  vendorContactEmail?: string;
  serviceName: string;
  bookingId: string;
  date: string;
  time: string;
  basePrice: number;
}): Promise<void> {
  try {
    const consumerUpcharge = params.basePrice * 0.08;
    const consumerTotal = params.basePrice + consumerUpcharge;
    const html = wrapEmail(`
      ${emailHeader('Booking Accepted! 🎉', `${params.vendorName} accepted your booking request.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Service', params.serviceName, true)}
          ${detailRow('Date', params.date, false)}
          ${detailRow('Time', params.time, true)}
          ${detailRow('Total Charged', cents(consumerTotal), false)}
        </table>
      </td></tr>
      ${emailCta('View My Bookings', 'https://goutsyde.com/account/bookings')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Booking accepted — ${params.serviceName} on ${params.date}`, html, { kind: 'booking', label: 'Booking accepted' });
  } catch (err) {
    console.error('[Email] sendBookingAcceptedToConsumer failed:', err);
  }
}

export async function sendBookingDeclinedToConsumer(params: {
  toEmail: string;
  consumerName: string;
  vendorName: string;
  serviceName: string;
  bookingId: string;
  date: string;
  reason?: string;
  expired?: boolean;
}): Promise<void> {
  try {
    const subject = params.expired
      ? `Booking request expired — ${params.serviceName}`
      : `Booking request not accepted — ${params.serviceName}`;
    const headline = params.expired
      ? 'Booking Request Expired'
      : 'Booking Request Not Accepted';
    const subheadline = params.expired
      ? `${params.vendorName} did not respond in time. No charge was made.`
      : `${params.vendorName} was unable to accept your request. No charge was made.`;
    const html = wrapEmail(`
      ${emailHeader(headline, subheadline)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Service', params.serviceName, true)}
          ${detailRow('Date', params.date, false)}
          ${params.reason ? detailRow('Reason', params.reason, true) : ''}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0;">Your card authorization has been released. You have not been charged.</p>
      </td></tr>
      ${emailCta('Find Another Provider', 'https://goutsyde.com')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, subject, html, { kind: 'booking', label: 'Booking declined' });
  } catch (err) {
    console.error('[Email] sendBookingDeclinedToConsumer failed:', err);
  }
}

// ─── Manual-accept request reminders and expiry (Part C, approved by Legend 2026-10-18) ──────────
// Copy rules: real punctuation, no dashes, never the service fee percentage. Dates and times arrive
// already formatted for the business/photographer's time zone (server/manualRequests.ts).

function escHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface RequestEmailParams {
  toEmail: string;
  /** 'booking' for a business appointment, 'shoot' for a photographer shoot. */
  kind: 'booking' | 'shoot';
  customerName: string;
  providerName: string;
  serviceName: string;
  /** e.g. "Sat, Oct 18" */
  dateLabel: string;
  /** e.g. "10:00 AM" */
  timeLabel: string;
  /** e.g. "Fri, Oct 17, 9:30 PM EDT" (reminder only) */
  deadlineLabel?: string;
}

const PROVIDER_DASHBOARD_URL = {
  booking: 'https://goutsyde.com/vendor-dashboard',
  shoot: 'https://goutsyde.com/photographer-dashboard',
} as const;

/** "Action needed" reminder to the business or photographer while the request can still be accepted. */
export async function sendRequestReminderToProvider(params: RequestEmailParams): Promise<void> {
  try {
    const customer = escHtml(params.customerName);
    const service = escHtml(params.serviceName);
    const deadline = escHtml(params.deadlineLabel ?? '');
    const html = wrapEmail(`
      ${emailHeader('Action needed', `${customer} is waiting for your answer.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Customer', customer, true)}
          ${detailRow('Service', service, false)}
          ${detailRow('Date', escHtml(params.dateLabel), true)}
          ${detailRow('Time', escHtml(params.timeLabel), false)}
          ${detailRow('Respond By', `<strong style="color:#E8B930;">${deadline}</strong>`, true)}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px 4px;">
        <p style="color:#F5F0E8;font-size:14px;line-height:1.5;margin:0;">${customer} already put a hold on their card for ${service} on ${escHtml(params.dateLabel)} at ${escHtml(params.timeLabel)} and is waiting for your answer. If you don't accept or decline by <strong style="color:#E8B930;">${deadline}</strong>, the request expires, the hold is released, and you lose this booking.</p>
      </td></tr>
      ${emailCta('Review request', PROVIDER_DASHBOARD_URL[params.kind])}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Action needed: ${params.customerName}'s booking request expires soon`, html, {
      kind: params.kind, label: params.kind === 'shoot' ? 'Shoot request reminder (photographer)' : 'Booking request reminder (vendor)',
    });
  } catch (err) {
    console.error('[Email] sendRequestReminderToProvider failed:', err);
  }
}

/** The request expired before the business or photographer accepted it. */
export async function sendRequestExpiredToProvider(params: RequestEmailParams): Promise<void> {
  try {
    const customer = escHtml(params.customerName);
    const service = escHtml(params.serviceName);
    const html = wrapEmail(`
      ${emailHeader('Booking lost', 'A booking request expired before it was accepted.')}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Customer', customer, true)}
          ${detailRow('Service', service, false)}
          ${detailRow('Date', escHtml(params.dateLabel), true)}
          ${detailRow('Time', escHtml(params.timeLabel), false)}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px 4px;">
        <p style="color:#F5F0E8;font-size:14px;line-height:1.5;margin:0;">${customer}'s request for ${service} on ${escHtml(params.dateLabel)} at ${escHtml(params.timeLabel)} expired because it wasn't accepted in time, so this booking was lost. The customer was not charged, and the time is open again. Respond to new requests quickly so you don't miss the next one.</p>
      </td></tr>
      ${emailCta('Open dashboard', PROVIDER_DASHBOARD_URL[params.kind])}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, 'You missed a booking request', html, {
      kind: params.kind, label: params.kind === 'shoot' ? 'Shoot request expired (photographer)' : 'Booking request expired (vendor)',
    });
  } catch (err) {
    console.error('[Email] sendRequestExpiredToProvider failed:', err);
  }
}

/** The customer's request expired: nothing charged, card hold released. */
export async function sendRequestExpiredToCustomer(params: RequestEmailParams): Promise<void> {
  try {
    const provider = escHtml(params.providerName);
    const service = escHtml(params.serviceName);
    const html = wrapEmail(`
      ${emailHeader('Your booking request expired', 'Nothing was charged.')}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow(params.kind === 'shoot' ? 'Photographer' : 'Business', provider, true)}
          ${detailRow('Service', service, false)}
          ${detailRow('Date', escHtml(params.dateLabel), true)}
          ${detailRow('Time', escHtml(params.timeLabel), false)}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px 4px;">
        <p style="color:#F5F0E8;font-size:14px;line-height:1.5;margin:0;">${provider} wasn't able to confirm ${service} on ${escHtml(params.dateLabel)} at ${escHtml(params.timeLabel)} in time, so your request has expired. Nothing was charged, and the hold on your card has been released. Times fill up fast, so grab another slot while it's open.</p>
      </td></tr>
      ${emailCta('Book again', 'https://goutsyde.com')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, 'Your booking request expired', html, {
      kind: params.kind, label: params.kind === 'shoot' ? 'Shoot request expired (customer)' : 'Booking request expired (customer)',
    });
  } catch (err) {
    console.error('[Email] sendRequestExpiredToCustomer failed:', err);
  }
}

export async function sendAdminBookingAlert(params: {
  type: 'new_pending' | 'accepted' | 'declined';
  businessName: string;
  customerName: string;
  serviceName: string;
  date?: string;
  amount?: string;
  bookingId: string;
  reason?: string;
}): Promise<void> {
  const subjects: Record<typeof params.type, string> = {
    new_pending: `[Outsyde] New Booking Request — ${params.businessName}`,
    accepted:    `[Outsyde] Booking Accepted — ${params.businessName}`,
    declined:    `[Outsyde] Booking Declined — ${params.businessName}`,
  };
  const typeLabel: Record<typeof params.type, string> = {
    new_pending: 'NEW PENDING',
    accepted:    'ACCEPTED',
    declined:    'DECLINED',
  };
  const typeColor: Record<typeof params.type, string> = {
    new_pending: '#E8B930',
    accepted:    '#34C759',
    declined:    '#FF3B30',
  };
  try {
    const rows = [
      detailRow('Type', typeLabel[params.type], true),
      detailRow('Booking ID', params.bookingId, false),
      detailRow('Business', params.businessName, true),
      detailRow('Customer', params.customerName, false),
      detailRow('Service', params.serviceName, true),
      ...(params.date   ? [detailRow('Date', params.date, false)]           : []),
      ...(params.amount ? [detailRow('Amount', params.amount, true)]        : []),
      ...(params.reason ? [detailRow('Decline Reason', params.reason, false)] : []),
    ].join('');
    const html = wrapEmail(`
      <tr>
        <td style="background:#1A1A1A;border-radius:10px 10px 0 0;padding:20px 32px;border-bottom:3px solid ${typeColor[params.type]};">
          <div style="color:#E8B930;font-size:20px;font-weight:900;letter-spacing:2px;">OUTSYDE</div>
          <h1 style="color:#F5F0E8;font-size:18px;font-weight:700;margin:8px 0 4px 0;">Booking ${typeLabel[params.type]}</h1>
          <p style="color:#888888;font-size:12px;margin:0;">${params.bookingId}</p>
        </td>
      </tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:4px;overflow:hidden;">${rows}</table>
      </td></tr>
      ${emailFooter()}
    `);
    await sendAdminEmail({ to: ADMIN_NOTIFICATION_EMAIL, subject: subjects[params.type], html });
  } catch (err) {
    console.error('[Email] sendAdminBookingAlert failed:', err);
  }
}

export async function sendAppointmentReminderEmail(params: {
  toEmail: string;
  customerName: string;
  serviceName: string;
  businessName: string;
  appointmentDate: string;
  appointmentTime: string;
  windowLabel: '24h' | '2h';
}): Promise<void> {
  const timeLabel = params.windowLabel === '24h' ? 'tomorrow' : 'in about 2 hours';
  const subject = `Your appointment is ${timeLabel} — ${params.businessName}`;
  const html = wrapEmail(`
    ${emailHeader(`Reminder: Your appointment is ${timeLabel} ✨`, params.businessName)}
    <tr>
      <td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#F5F0E8;font-size:15px;margin:0 0 12px 0;">Hi ${params.customerName},</p>
        <p style="color:#AAAAAA;font-size:14px;margin:0 0 20px 0;">
          Just a heads-up — your <strong style="color:#E8B930;">${params.serviceName}</strong> appointment at
          <strong style="color:#E8B930;">${params.businessName}</strong> is coming up.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${detailRow('Date', params.appointmentDate, true)}
          ${detailRow('Time', params.appointmentTime, false)}
          ${detailRow('Service', params.serviceName, true)}
        </table>
        <p style="color:#AAAAAA;font-size:13px;margin:20px 0 0 0;">
          If you need to cancel or reschedule, please contact ${params.businessName} as soon as possible
          to avoid a late-cancellation fee.
        </p>
      </td>
    </tr>
    ${emailFooter('See you soon!')}
  `);
  await sendBrandedEmail(params.toEmail, subject, html, { kind: 'booking', label: 'Appointment reminder' });
}

export async function sendAftercareEmail(params: {
  toEmail: string;
  customerName: string;
  serviceName: string;
  businessName: string;
  loyaltyPointsEarned?: number;
}): Promise<void> {
  const subject = 'Your ritual is complete ✨ — XO Beauty & Lashes aftercare guide';
  const html = wrapEmail(`
    ${emailHeader('Your appointment is complete! ✨', `Thank you for choosing ${params.businessName}`)}
    <tr>
      <td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#F5F0E8;font-size:15px;margin:0 0 12px 0;">Hi ${params.customerName},</p>
        <p style="color:#AAAAAA;font-size:14px;margin:0 0 20px 0;">
          Your <strong style="color:#E8B930;">${params.serviceName}</strong> session is complete.
          To keep your results looking their best, please follow these aftercare guidelines:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${detailRow('First 24 hours', 'Avoid touching, rubbing, or getting your lashes wet.', true)}
          ${detailRow('Avoid steam & heat', 'Stay away from saunas, steam rooms, and hot showers directly on your face.', false)}
          ${detailRow('Cleansing', 'Use a gentle, oil-free cleanser around the eye area only.', true)}
          ${detailRow('No mascara', 'Avoid mascara, especially waterproof formulas, to extend retention.', false)}
          ${detailRow('Brush daily', 'Gently brush lashes with the provided spoolie every morning.', true)}
          ${detailRow('Schedule fills', 'Book your next fill in 2–3 weeks to maintain fullness.', false)}
        </table>
        ${params.loyaltyPointsEarned ? `
        <div style="margin-top:20px;background:#1A3C34;border-radius:8px;padding:14px 20px;text-align:center;">
          <span style="color:#E8B930;font-size:14px;font-weight:700;">🎉 +${params.loyaltyPointsEarned} Outsyde Points earned!</span>
        </div>` : ''}
      </td>
    </tr>
    ${emailFooter('We look forward to seeing you again soon.')}
  `);
  await sendBrandedEmail(params.toEmail, subject, html, { kind: 'booking', label: 'Aftercare' });
}

// Deposit booking confirmation to customer — parameterized for any vendor using the deposit flow.
export async function sendBookingConfirmationToCustomer(params: {
  toEmail: string
  customerName: string
  serviceName: string
  date: string
  time: string
  appointmentId: string
  // Vendor branding. Defaults are Outsyde's, never another vendor's.
  businessName?: string
  fromAddress?: string   // e.g. 'XO Beauty & Lashes <bookings@xobeautyandlashes.com>'
  vendorContactEmail?: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    throw new Error('[emailService] RESEND_API_KEY not set')
  }

  const displayName = params.businessName || 'Outsyde'
  const from = params.fromAddress || FROM_ORDERS
  const contactEmail = params.vendorContactEmail || 'info@goutsyde.com'

  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)

  const subject = `Your appointment is confirmed — ${displayName}`
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;">
      <div style="background:linear-gradient(135deg,#2e1a47,#c9b1d9);padding:32px;text-align:center;">
        <h1 style="color:white;margin:0;font-size:22px;letter-spacing:-0.3px;">${displayName}</h1>
        <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px;">Your appointment is confirmed</p>
      </div>
      <div style="padding:32px;">
        <p style="font-size:15px;color:#1a0f2e;margin:0 0 24px;">Hi ${params.customerName},</p>
        <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 24px;">
          Your appointment has been confirmed. The team will reach out if anything changes. See you soon!
        </p>
        <div style="background:#f7f2fc;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
          <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.1em;color:#888;">BOOKING DETAILS</p>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="font-size:13px;color:#888;padding:4px 0;">Service</td><td style="font-size:13px;color:#1a0f2e;font-weight:500;text-align:right;">${params.serviceName}</td></tr>
            <tr><td style="font-size:13px;color:#888;padding:4px 0;">Date</td><td style="font-size:13px;color:#1a0f2e;font-weight:500;text-align:right;">${params.date}</td></tr>
            <tr><td style="font-size:13px;color:#888;padding:4px 0;">Time</td><td style="font-size:13px;color:#1a0f2e;font-weight:500;text-align:right;">${params.time}</td></tr>
            <tr><td style="font-size:13px;color:#888;padding:4px 0;">Reference</td><td style="font-size:13px;color:#1a0f2e;font-weight:500;text-align:right;">#${params.appointmentId.slice(0,8).toUpperCase()}</td></tr>
          </table>
        </div>
        <p style="font-size:13px;color:#888;text-align:center;">Questions? Reply to this email or contact <a href="mailto:${contactEmail}" style="color:#6b46c1;">${contactEmail}</a></p>
      </div>
      <div style="background:#f5f5f5;padding:16px;text-align:center;">
        <p style="margin:0;font-size:12px;color:#999;">${displayName} · ${contactEmail}</p>
      </div>
    </div>
  `

  const logTag: EmailLogTag = { kind: 'booking', label: 'Deposit booking confirmation' }
  let result: Awaited<ReturnType<typeof resend.emails.send>>
  try {
    result = await resend.emails.send({
      from,
      to: params.toEmail,
      subject,
      html,
    })
  } catch (err) {
    logTransactionalEmail(logTag, params.toEmail, { error: err })
    throw err
  }
  if (result.error) {
    logTransactionalEmail(logTag, params.toEmail, { error: result.error.message ?? result.error })
    throw new Error(`Resend error: ${result.error.message ?? JSON.stringify(result.error)}`)
  }
  logTransactionalEmail(logTag, params.toEmail, { resendId: result.data?.id })
}

// Deposit booking alert to vendor — parameterized for any vendor using the deposit flow.
export async function sendNewBookingAlertToVendor(params: {
  customerName: string
  customerEmail: string
  serviceName: string
  date: string
  time: string
  appointmentId: string
  // Vendor params. Defaults are Outsyde's, never another vendor's.
  vendorOwnerEmail?: string
  businessName?: string
  fromAddress?: string
  depositAmountCents?: number // stored deposit amount; falls back to display text if absent
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    throw new Error('[emailService] RESEND_API_KEY not set')
  }
  if (!params.vendorOwnerEmail) {
    throw new Error('[emailService] no vendor owner email for deposit booking alert')
  }

  const toEmail = params.vendorOwnerEmail
  const displayName = params.businessName || 'Outsyde'
  const from = params.fromAddress || FROM_ORDERS
  const depositLabel = params.depositAmountCents != null
    ? `$${(params.depositAmountCents / 100).toFixed(2)} deposit`
    : 'A deposit'

  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)

  const subject = `New booking: ${params.customerName} — ${params.serviceName}`
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;">
      <div style="background:linear-gradient(135deg,#2e1a47,#c9b1d9);padding:32px;text-align:center;">
        <h1 style="color:white;margin:0;font-size:22px;">New Booking</h1>
        <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px;">${displayName}</p>
      </div>
      <div style="padding:32px;">
        <p style="font-size:15px;color:#1a0f2e;margin:0 0 24px;">A new appointment has been booked.</p>
        <div style="background:#f7f2fc;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
          <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.1em;color:#888;">APPOINTMENT DETAILS</p>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="font-size:13px;color:#888;padding:4px 0;">Customer</td><td style="font-size:13px;color:#1a0f2e;font-weight:500;text-align:right;">${params.customerName}</td></tr>
            <tr><td style="font-size:13px;color:#888;padding:4px 0;">Email</td><td style="font-size:13px;color:#1a0f2e;font-weight:500;text-align:right;">${params.customerEmail}</td></tr>
            <tr><td style="font-size:13px;color:#888;padding:4px 0;">Service</td><td style="font-size:13px;color:#1a0f2e;font-weight:500;text-align:right;">${params.serviceName}</td></tr>
            <tr><td style="font-size:13px;color:#888;padding:4px 0;">Date</td><td style="font-size:13px;color:#1a0f2e;font-weight:500;text-align:right;">${params.date}</td></tr>
            <tr><td style="font-size:13px;color:#888;padding:4px 0;">Time</td><td style="font-size:13px;color:#1a0f2e;font-weight:500;text-align:right;">${params.time}</td></tr>
            <tr><td style="font-size:13px;color:#888;padding:4px 0;">Reference</td><td style="font-size:13px;color:#1a0f2e;font-weight:500;text-align:right;">#${params.appointmentId.slice(0,8).toUpperCase()}</td></tr>
          </table>
        </div>
        <p style="font-size:13px;color:#888;text-align:center;">${depositLabel} was collected to secure this slot.</p>
      </div>
      <div style="background:#f5f5f5;padding:16px;text-align:center;">
        <p style="margin:0;font-size:12px;color:#999;">${displayName} Dashboard</p>
      </div>
    </div>
  `

  const logTag: EmailLogTag = { kind: 'booking', label: 'New deposit booking (vendor)' }
  let result: Awaited<ReturnType<typeof resend.emails.send>>
  try {
    result = await resend.emails.send({
      from,
      to: toEmail,
      subject,
      html,
    })
  } catch (err) {
    logTransactionalEmail(logTag, toEmail, { error: err })
    throw err
  }
  if (result.error) {
    logTransactionalEmail(logTag, toEmail, { error: result.error.message ?? result.error })
    throw new Error(`Resend error: ${result.error.message ?? JSON.stringify(result.error)}`)
  }
  logTransactionalEmail(logTag, toEmail, { resendId: result.data?.id })
}

export async function sendOrderDeliveredEmail(params: {
  toEmail: string;
  consumerName: string;
  vendorName: string;
  orderId: string;
  orderNumber: number;
  items: Array<{ productName: string; variantLabel?: string; quantity: number }>;
}): Promise<void> {
  try {
    const orderRef = `#${String(params.orderNumber).padStart(4, '0')}`;
    const itemRows = params.items.map((item, i) => {
      const nameCell = item.variantLabel
        ? `${item.productName}<br/><span style="color:#888888;font-size:12px;">${item.variantLabel}</span>`
        : item.productName;
      return detailRow(nameCell, `Qty: ${item.quantity}`, i % 2 === 0);
    }).join('');
    const html = wrapEmail(`
      ${emailHeader('Order Delivered! ✅', `Your order from ${params.vendorName} has arrived.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <p style="color:#888888;font-size:12px;margin:0 0 8px 0;">Order ${orderRef}</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${itemRows}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0;">
          Enjoying your purchase? Leave a review for ${params.vendorName} and earn Outsyde points.
        </p>
      </td></tr>
      ${emailCta('View My Orders', 'https://goutsyde.com/account/orders')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Your order ${orderRef} has been delivered!`, html, { kind: 'order', label: 'Order delivered' });
    console.log(`[Email] Order delivered email sent to ${params.toEmail} for order ${params.orderId}`);
  } catch (err) {
    console.error('[Email] sendOrderDeliveredEmail failed:', err);
  }
}

export async function sendOrderDeliveredVendorEmail(params: {
  toEmail: string;
  vendorName: string;
  consumerName: string;
  orderId: string;
  orderNumber: number;
  items: Array<{ productName: string; variantLabel?: string; quantity: number }>;
}): Promise<void> {
  try {
    const orderRef = `#${String(params.orderNumber).padStart(4, '0')}`;
    const itemRows = params.items.map((item, i) => {
      const nameCell = item.variantLabel
        ? `${item.productName}<br/><span style="color:#888888;font-size:12px;">${item.variantLabel}</span>`
        : item.productName;
      return detailRow(nameCell, `Qty: ${item.quantity}`, i % 2 === 0);
    }).join('');
    const html = wrapEmail(`
      ${emailHeader('Order Delivered ✅', `${params.consumerName} confirmed receipt of order ${orderRef}.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Customer', params.consumerName, true)}
          ${detailRow('Order', orderRef, false)}
        </table>
        <p style="color:#888888;font-size:12px;margin:12px 0 8px 0;">Items delivered:</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${itemRows}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
        <p style="color:#888888;font-size:13px;margin:0;">Your payout for this order has been processed.</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/orders')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Order ${orderRef} confirmed delivered`, html, { kind: 'order', label: 'Order delivered (vendor)' });
    console.log(`[Email] Order delivered vendor email sent to ${params.toEmail} for order ${params.orderId}`);
  } catch (err) {
    console.error('[Email] sendOrderDeliveredVendorEmail failed:', err);
  }
}

/**
 * Internal alert: booking payouts Stripe has not sent yet (server/payouts.ts). Goes to the admin
 * inbox only; not logged in customer email history.
 */
export async function sendPayoutAlertToAdmin(params: {
  items: Array<{ bookingType: string; bookingId: string; recipient: string; amountCents: number; attempts: number; lastError: string; since: string; topUpRequested: boolean }>;
  totalCents: number;
  availableCents: number | null;
  autoTopUpCapCents: number;
}): Promise<void> {
  const esc = (v: string) => v.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
  const short = params.availableCents != null ? Math.max(0, params.totalCents - params.availableCents) : null;
  const summary = [
    detailRow('Unpaid payouts', String(params.items.length), true),
    detailRow('Total owed to businesses', cents(params.totalCents), false),
    detailRow('Stripe available balance', params.availableCents != null ? cents(params.availableCents) : 'Could not read', true),
    ...(short != null && short > 0 ? [detailRow('Add at least', cents(short), false)] : []),
    detailRow('Automatic top up', params.autoTopUpCapCents > 0 ? `On, up to ${cents(params.autoTopUpCapCents)}` : 'Off', true),
  ].join('');
  const list = params.items.slice(0, 25).map((it, i) => detailRow(
    `${esc(it.bookingType)} ${esc(it.bookingId.slice(0, 8))} (${esc(it.recipient)})`,
    `${cents(it.amountCents)}. Tried ${it.attempts} time${it.attempts === 1 ? '' : 's'}. ${esc(it.lastError.slice(0, 160))}${it.topUpRequested ? ' Top up requested.' : ''}`,
    i % 2 === 0,
  )).join('');
  const html = wrapEmail(`
    ${emailHeader('Business payouts waiting', 'Stripe has not sent these payouts yet. Outsyde retries every hour.')}
    <tr><td style="background:#1A1A1A;padding:0 32px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">${summary}</table>
    </td></tr>
    <tr><td style="background:#1A1A1A;padding:16px 32px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">${list}</table>
    </td></tr>
    <tr><td style="background:#1A1A1A;padding:16px 32px;">
      <p style="color:#AAAAAA;font-size:13px;margin:0;">Most often this means the available Stripe balance is too low. Add funds in Stripe (Balance, Add to balance, Payments balance). Payouts go out on the next hourly retry once the money is available.</p>
    </td></tr>
    ${emailFooter()}
  `);
  await sendBrandedEmail(ADMIN_NOTIFICATION_EMAIL, `[Outsyde] ${params.items.length} business payout${params.items.length === 1 ? '' : 's'} waiting (${cents(params.totalCents)})`, html);
}

/**
 * Seller notice: part of a refund is owed back because the seller's Stripe balance didn't cover it
 * (server/bookingRecoveries.ts). Copy comes from the caller: real punctuation, no dashes, no fee percentage.
 * Logged in email history with a plain label (no personal data). Throws on a send failure; the caller catches.
 */
export async function sendRefundOwedEmail(params: {
  to: string;
  kind: 'booking' | 'shoot' | 'staff' | 'ticket';
  subject: string;
  text: string;
}): Promise<void> {
  const html = wrapEmail(`
    ${emailHeader(escapeHtml(params.subject), 'About a recent refund')}
    <tr><td style="background:#1A1A1A;padding:8px 32px 24px;">
      <p style="color:#FFFFFF;font-size:15px;line-height:1.6;margin:0;">${escapeHtml(params.text)}</p>
    </td></tr>
    ${emailFooter()}
  `);
  await sendBrandedEmail(params.to, params.subject, html, { kind: params.kind, label: 'Refund owed notice' });
}

/** Seller notice that a refund's share was taken back from their Stripe balance. Same layout as sendRefundOwedEmail. */
export async function sendRefundTakenBackEmail(params: {
  to: string;
  kind: 'booking' | 'shoot' | 'staff' | 'ticket';
  subject: string;
  text: string;
}): Promise<void> {
  const html = wrapEmail(`
    ${emailHeader(escapeHtml(params.subject), 'About a recent refund')}
    <tr><td style="background:#1A1A1A;padding:8px 32px 24px;">
      <p style="color:#FFFFFF;font-size:15px;line-height:1.6;margin:0;">${escapeHtml(params.text)}</p>
    </td></tr>
    ${emailFooter()}
  `);
  await sendBrandedEmail(params.to, params.subject, html, { kind: params.kind, label: 'Refund taken back notice' });
}

// ─── Event tickets (Events & Ticketing Phase 2 PR 4) ─────────────────────────
// Copy rules: real punctuation, no dashes, and the service fee is named but never given as a percentage.
// Every value from the database is escaped. These throw on a send failure; callers catch.

export interface TicketEmailEvent {
  title: string;
  /** Already formatted in the event's own time zone, e.g. "Saturday, October 24 at 8:00 PM EDT". */
  whenText: string;
  /** Venue and address, or null when the event has none. */
  whereText: string | null;
}

function ticketEventRows(ev: TicketEmailEvent): string {
  return `
    ${detailRow('Event', escapeHtml(ev.title), true)}
    ${detailRow('When', escapeHtml(ev.whenText), false)}
    ${ev.whereText ? detailRow('Where', escapeHtml(ev.whereText), true) : ''}`;
}

export type TicketReceiptParams = {
  toEmail: string;
  firstName: string | null;
  event: TicketEmailEvent;
  ticketTypeName: string;
  quantity: number;
  ticketPriceCents: number;
  serviceFeeCents: number;
  totalCents: number;
  codes: string[];
  /** One QR image URL per code, same order. Only used when the length matches codes. */
  qrUrls?: string[];
};

export function renderTicketReceipt(params: TicketReceiptParams): { subject: string; html: string } {
  const free = params.totalCents === 0;
  const hello = params.firstName ? `Hi ${escapeHtml(params.firstName)}, you're going.` : `You're going.`;
  const qrUrls = params.qrUrls && params.qrUrls.length === params.codes.length ? params.qrUrls : null;
  const codeRows = params.codes
    .map((c, i) => {
      const qr = qrUrls ? `<img src="${escapeHtml(qrUrls[i])}" width="160" height="160" alt="QR code for ticket ${i + 1}" style="display:block;border:0;">` : '';
      return detailRow(`Ticket ${i + 1}`, `${qr}<span style="font-family:monospace;letter-spacing:2px;">${escapeHtml(c)}</span>`, i % 2 === 0);
    })
    .join('');
  const moneyRows = free ? '' : `
    ${detailRow('Tickets', `${params.quantity} x ${escapeHtml(params.ticketTypeName)}, ${cents(params.ticketPriceCents)}`, true)}
    ${detailRow('Service fee', cents(params.serviceFeeCents), false)}
    ${detailRow('Total charged', cents(params.totalCents), true)}`;
  const html = wrapEmail(`
    ${emailHeader(free ? 'Your RSVP is confirmed' : 'Your tickets are confirmed', hello)}
    <tr><td style="background:#1A1A1A;padding:0 32px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;border:1px solid #2A2A2A;">
        ${ticketEventRows(params.event)}
        ${free ? detailRow('Tickets', `${params.quantity} x ${escapeHtml(params.ticketTypeName)}`, false) : ''}
      </table>
      ${moneyRows ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">${moneyRows}</table>` : ''}
      <p style="color:#888888;font-size:13px;margin:16px 0 8px 0;">${qrUrls ? 'Show the QR code at the door. Each code lets one person in.' : 'Show a ticket code at the door. Each code lets one person in.'}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;border:1px solid #2A2A2A;">${codeRows}</table>
    </td></tr>
    ${emailFooter('Keep this email. Your ticket codes are also in your Outsyde account.')}
  `);
  return { subject: `${free ? 'RSVP confirmed' : 'Your tickets'}: ${params.event.title}`, html };
}

export async function sendTicketReceiptToBuyer(params: TicketReceiptParams): Promise<void> {
  const { subject, html } = renderTicketReceipt(params);
  await sendBrandedEmail(params.toEmail, subject, html, { kind: 'ticket', label: params.totalCents === 0 ? 'RSVP confirmation' : 'Ticket receipt' });
}

export type AddressRevealParams = {
  toEmail: string;
  firstName: string | null;
  /** whereText is the full address here: this email is only sent once the reveal time has passed. */
  event: TicketEmailEvent;
  /** Link to My Tickets. */
  ticketsUrl: string;
};

export function renderAddressReveal(params: AddressRevealParams): { subject: string; html: string } {
  const name = params.firstName ? `Hi ${escapeHtml(params.firstName)}, ` : '';
  const html = wrapEmail(`
    ${emailHeader('Your event address is ready', `${name}the address for this event is now available.`)}
    <tr><td style="background:#1A1A1A;padding:0 32px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;border:1px solid #2A2A2A;">${ticketEventRows(params.event)}</table>
      <p style="color:#888888;font-size:13px;margin:16px 0 8px 0;">You can always find the address and your ticket codes in My Tickets.</p>
      <p style="text-align:center;margin:16px 0 8px 0;">
        <a href="${escapeHtml(params.ticketsUrl)}" style="background:#E8B930;color:#111111;padding:12px 30px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">Open My Tickets</a>
      </p>
    </td></tr>
    ${emailFooter()}
  `);
  return { subject: `Your address is ready: ${params.event.title}`, html };
}

export async function sendAddressRevealToHolder(params: AddressRevealParams): Promise<void> {
  const { subject, html } = renderAddressReveal(params);
  await sendBrandedEmail(params.toEmail, subject, html, { kind: 'ticket', label: 'Event address reveal' });
}

export type TicketRefundParams = {
  toEmail: string;
  firstName: string | null;
  event: TicketEmailEvent;
  reason: 'buyer' | 'host' | 'event_cancelled';
  refundCents: number;
  /** Service fee Outsyde kept on this refund (0 when everything came back). */
  keptFeeCents: number;
  cancelReason?: string | null;
};

export function renderTicketRefund(params: TicketRefundParams): { subject: string; html: string } {
  const name = params.firstName ? `Hi ${escapeHtml(params.firstName)}, ` : '';
  const heading = params.reason === 'event_cancelled' ? 'This event was cancelled' : 'Your refund is on its way';
  const lead = params.reason === 'event_cancelled'
    ? `${name}the host cancelled this event, so your full payment is coming back to you.`
    : params.reason === 'host'
      ? `${name}the host refunded your tickets.`
      : `${name}your tickets were cancelled and refunded.`;
  const rows = `
    ${ticketEventRows(params.event)}
    ${params.cancelReason ? detailRow('Message from the host', escapeHtml(params.cancelReason), false) : ''}
    ${detailRow('Refund', cents(params.refundCents), true)}
    ${params.keptFeeCents > 0 ? detailRow('Service fee', `${cents(params.keptFeeCents)}, not refunded`, false) : ''}`;
  const html = wrapEmail(`
    ${emailHeader(heading, lead)}
    <tr><td style="background:#1A1A1A;padding:0 32px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;border:1px solid #2A2A2A;">${rows}</table>
      <p style="color:#888888;font-size:13px;margin:16px 0 8px 0;">The money goes back to the card you paid with. Banks usually show it within 5 to 10 business days. Your ticket codes no longer work.</p>
    </td></tr>
    ${emailFooter()}
  `);
  return { subject: `${params.reason === 'event_cancelled' ? 'Event cancelled' : 'Refund'}: ${params.event.title}`, html };
}

export async function sendTicketRefundToBuyer(params: TicketRefundParams): Promise<void> {
  const { subject, html } = renderTicketRefund(params);
  await sendBrandedEmail(params.toEmail, subject, html,
    { kind: 'ticket', label: params.reason === 'event_cancelled' ? 'Event cancelled, refund' : 'Ticket refund' });
}

export type EventCancelledParams = {
  toEmail: string;
  firstName: string | null;
  event: TicketEmailEvent;
  cancelReason?: string | null;
};

export function renderEventCancelled(params: EventCancelledParams): { subject: string; html: string } {
  const name = params.firstName ? `Hi ${escapeHtml(params.firstName)}, ` : '';
  const html = wrapEmail(`
    ${emailHeader('This event was cancelled', `${name}the host cancelled this event, so your RSVP is cancelled too.`)}
    <tr><td style="background:#1A1A1A;padding:0 32px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;border:1px solid #2A2A2A;">
        ${ticketEventRows(params.event)}
        ${params.cancelReason ? detailRow('Message from the host', escapeHtml(params.cancelReason), false) : ''}
      </table>
      <p style="color:#888888;font-size:13px;margin:16px 0 8px 0;">This was a free RSVP, so nothing was charged.</p>
    </td></tr>
    ${emailFooter()}
  `);
  return { subject: `Event cancelled: ${params.event.title}`, html };
}

export async function sendEventCancelledToGuest(params: EventCancelledParams): Promise<void> {
  const { subject, html } = renderEventCancelled(params);
  await sendBrandedEmail(params.toEmail, subject, html, { kind: 'ticket', label: 'Event cancelled' });
}
