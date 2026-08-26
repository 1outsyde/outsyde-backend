import { Resend } from 'resend';

async function getCredentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  const connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=resend',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  if (!connectionSettings || (!connectionSettings.settings.api_key)) {
    throw new Error('Resend not connected');
  }
  
  const fromEmail = connectionSettings.settings.from_email;
  if (!fromEmail) {
    throw new Error('Resend from_email not configured');
  }
  
  return { apiKey: connectionSettings.settings.api_key, fromEmail };
}

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

export async function getUncachableResendClient() {
  const { apiKey, fromEmail } = await getCredentials();
  return {
    client: new Resend(apiKey),
    fromEmail
  };
}

export async function isEmailConfigured(): Promise<boolean> {
  try {
    await getCredentials();
    return true;
  } catch {
    return false;
  }
}

export interface AdminEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendAdminEmail(params: AdminEmailParams): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableResendClient();
    
    const result = await client.emails.send({
      from: fromEmail,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });

    if (result.error) {
      console.error('[Email] Failed to send email:', result.error);
      return false;
    }

    console.log(`[Email] Sent to ${params.to}: ${params.subject}`);
    return true;
  } catch (error) {
    console.error('[Email] Error sending email:', error);
    return false;
  }
}

export async function sendNewVendorApplicationEmail(params: {
  adminEmail: string;
  businessName: string;
  businessCategory: string;
  ownerName: string;
  ownerEmail: string;
  location?: string | null;
  businessId: string;
}): Promise<boolean> {
  const subject = `New Vendor Application: ${params.businessName}`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f5a623, #f7b84b); padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">New Vendor Application</h1>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #333;">A new business has applied to join Outsyde:</p>
        
        <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h2 style="color: #333; margin-top: 0;">${params.businessName}</h2>
          <p style="margin: 8px 0;"><strong>Category:</strong> ${params.businessCategory}</p>
          <p style="margin: 8px 0;"><strong>Owner:</strong> ${params.ownerName}</p>
          <p style="margin: 8px 0;"><strong>Email:</strong> ${params.ownerEmail}</p>
          ${params.location ? `<p style="margin: 8px 0;"><strong>Location:</strong> ${params.location}</p>` : ''}
        </div>
        
        <div style="text-align: center; margin-top: 30px;">
          <a href="${getAppBaseUrl()}/admin/applications/${params.businessId}" 
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

  const baseUrl = getAppBaseUrl();
  const text = `
New Vendor Application: ${params.businessName}

A new business has applied to join Outsyde:

Business Name: ${params.businessName}
Category: ${params.businessCategory}
Owner: ${params.ownerName}
Email: ${params.ownerEmail}
${params.location ? `Location: ${params.location}` : ''}

${baseUrl ? `Review: ${baseUrl}/admin/applications/${params.businessId}` : 'Please log in to the admin panel to review this application.'}
  `;

  return sendAdminEmail({
    to: params.adminEmail,
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
}): Promise<boolean> {
  const subject = `New Photographer Application: ${params.displayName}`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f5a623, #f7b84b); padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">New Photographer Application</h1>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #333;">A new photographer has applied to join Outsyde:</p>
        
        <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h2 style="color: #333; margin-top: 0;">${params.displayName}</h2>
          <p style="margin: 8px 0;"><strong>Name:</strong> ${params.ownerName}</p>
          <p style="margin: 8px 0;"><strong>Email:</strong> ${params.ownerEmail}</p>
          ${params.location ? `<p style="margin: 8px 0;"><strong>Location:</strong> ${params.location}</p>` : ''}
          ${params.specialties && params.specialties.length > 0 ? `<p style="margin: 8px 0;"><strong>Specialties:</strong> ${params.specialties.join(', ')}</p>` : ''}
        </div>
        
        <div style="text-align: center; margin-top: 30px;">
          <a href="${getAppBaseUrl()}/admin/photographer-applications/${params.photographerId}" 
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

  const baseUrl = getAppBaseUrl();
  const text = `
New Photographer Application: ${params.displayName}

A new photographer has applied to join Outsyde:

Display Name: ${params.displayName}
Name: ${params.ownerName}
Email: ${params.ownerEmail}
${params.location ? `Location: ${params.location}` : ''}
${params.specialties && params.specialties.length > 0 ? `Specialties: ${params.specialties.join(', ')}` : ''}

${baseUrl ? `Review: ${baseUrl}/admin/photographer-applications/${params.photographerId}` : 'Please log in to the admin panel to review this application.'}
  `;

  return sendAdminEmail({
    to: params.adminEmail,
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

const FROM_ORDERS = 'orders@info.goutsyde.com';

async function sendBrandedEmail(to: string, subject: string, html: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('[emailService] RESEND_API_KEY not set');
  }
  const resend = new Resend(apiKey);
  const result = await resend.emails.send({ from: FROM_ORDERS, to, subject, html });
  if (result.error) {
    const errMsg = typeof result.error === 'object' && result.error !== null
      ? (result.error as { message?: string }).message ?? JSON.stringify(result.error)
      : String(result.error);
    throw new Error(`Resend error: ${errMsg}`);
  }
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

function emailHeader(heading: string, subheading: string): string {
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

function emailCta(label: string, url: string): string {
  return `<tr>
    <td style="background:#1A1A1A;padding:24px 32px;">
      <div style="text-align:center;">
        <a href="${url}" style="display:inline-block;background:#1A3C34;color:#E8B930;padding:14px 36px;text-decoration:none;border-radius:6px;font-weight:700;font-size:15px;letter-spacing:0.5px;">${label}</a>
      </div>
    </td>
  </tr>`;
}

function emailFooter(extra?: string): string {
  return `<tr>
    <td style="background:#111111;border-radius:0 0 10px 10px;padding:20px 32px;text-align:center;">
      ${extra ? `<p style="color:#AAAAAA;font-size:13px;margin:0 0 10px 0;">${extra}</p>` : ''}
      <p style="color:#555555;font-size:12px;margin:0 0 4px 0;">For questions contact us at <a href="mailto:info@goutsyde.com" style="color:#E8B930;text-decoration:none;">info@goutsyde.com</a></p>
      <p style="color:#444444;font-size:11px;margin:0;">info@goutsyde.com &nbsp;·&nbsp; Culture meets commerce &nbsp;·&nbsp; Go Outsyde</p>
    </td>
  </tr>`;
}

function wrapEmail(innerRows: string): string {
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
  date: string;
  time: string;
  location?: string;
  basePrice: number;
}): Promise<void> {
  try {
    const consumerUpcharge = params.basePrice * 0.08;
    const consumerTotal = params.basePrice + consumerUpcharge;

    const rows = [
      { label: 'Service', value: params.serviceName },
      { label: 'Date', value: params.date },
      { label: 'Time', value: params.time },
      ...(params.location ? [{ label: 'Location', value: params.location }] : []),
      { label: 'Total Paid', value: cents(consumerTotal) },
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

    await sendBrandedEmail(params.toEmail, `🎉 Your appointment is confirmed — ${params.serviceName}`, html);
    console.log(`[Email] Appointment confirmation sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendAppointmentConfirmationToConsumer failed:', err);
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
  date: string;
  time: string;
  location?: string;
  basePrice: number;
}): Promise<void> {
  try {
    const vendorFee = params.basePrice * 0.02;
    const vendorPayout = params.basePrice - vendorFee;

    const customerDisplay = params.consumerDisplayName || params.consumerName;
    const usernameDisplay = params.consumerUsername ? `@${params.consumerUsername}` : '';

    const rows = [
      { label: 'Customer Name', value: customerDisplay },
      ...(usernameDisplay ? [{ label: 'Customer Username', value: usernameDisplay }] : []),
      { label: 'Service', value: params.serviceName },
      { label: 'Date', value: params.date },
      { label: 'Time', value: params.time },
      ...(params.location ? [{ label: 'Location', value: params.location }] : []),
      { label: 'Your Payout', value: cents(vendorPayout) },
    ].map((r, i) => detailRow(r.label, r.value, i % 2 === 0)).join('');

    const html = wrapEmail(`
      ${emailHeader('New Booking Received! 🎉', 'Congratulations! You have a new appointment booking.')}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">${rows}</table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
        <p style="color:#555555;font-size:12px;margin:0;">Outsyde platform fee: 2% (${cents(vendorFee)})</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);

    await sendBrandedEmail(params.toEmail, `🎉 New booking received — ${params.serviceName}`, html);
    console.log(`[Email] Appointment vendor notification sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendAppointmentNotificationToVendor failed:', err);
  }
}

export async function sendShootBookingConfirmationToConsumer(params: {
  toEmail: string;
  consumerName: string;
  photographerName: string;
  photographerContactEmail?: string;
  shootType: string;
  bookingId: string;
  date: string;
  time: string;
  location?: string;
  basePrice: number;
}): Promise<void> {
  try {
    const consumerUpcharge = params.basePrice * 0.08;
    const consumerTotal = params.basePrice + consumerUpcharge;

    const rows = [
      { label: 'Shoot Type', value: params.shootType },
      { label: 'Photographer', value: params.photographerName },
      { label: 'Date', value: params.date },
      { label: 'Time', value: params.time },
      ...(params.location ? [{ label: 'Location', value: params.location }] : []),
      { label: 'Total Paid', value: cents(consumerTotal) },
    ].map((r, i) => detailRow(r.label, r.value, i % 2 === 0)).join('');

    const contactLines = [
      ...(params.photographerContactEmail ? [`<span style="color:#FFFFFF;">${params.photographerName}:</span> <a href="mailto:${params.photographerContactEmail}" style="color:#E8B930;">${params.photographerContactEmail}</a>`] : []),
      `<span style="color:#FFFFFF;">Outsyde Support:</span> <a href="mailto:info@goutsyde.com" style="color:#E8B930;">info@goutsyde.com</a>`,
    ].map(l => `<li style="margin-bottom:4px;">${l}</li>`).join('');

    const html = wrapEmail(`
      ${emailHeader('Shoot Booked! 🎉', `Your session with ${params.photographerName} is locked in.`)}
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

    await sendBrandedEmail(params.toEmail, `🎉 Your shoot is confirmed — ${params.shootType}`, html);
    console.log(`[Email] Shoot confirmation sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendShootBookingConfirmationToConsumer failed:', err);
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
  date: string;
  time: string;
  location?: string;
  basePrice: number;
}): Promise<void> {
  try {
    const vendorFee = params.basePrice * 0.02;
    const vendorPayout = params.basePrice - vendorFee;

    const clientDisplay = params.consumerDisplayName || params.consumerName;
    const usernameDisplay = params.consumerUsername ? `@${params.consumerUsername}` : '';

    const rows = [
      { label: 'Client Name', value: clientDisplay },
      ...(usernameDisplay ? [{ label: 'Client Username', value: usernameDisplay }] : []),
      { label: 'Shoot Type', value: params.shootType },
      { label: 'Date', value: params.date },
      { label: 'Time', value: params.time },
      ...(params.location ? [{ label: 'Location', value: params.location }] : []),
      { label: 'Your Payout', value: cents(vendorPayout) },
    ].map((r, i) => detailRow(r.label, r.value, i % 2 === 0)).join('');

    const html = wrapEmail(`
      ${emailHeader('New Shoot Booking! 🎉', 'Congratulations! You have a new shoot booking.')}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">${rows}</table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
        <p style="color:#555555;font-size:12px;margin:0;">Outsyde platform fee: 2% (${cents(vendorFee)})</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);

    await sendBrandedEmail(params.toEmail, `🎉 New shoot booked — ${params.shootType}`, html);
    console.log(`[Email] Shoot photographer notification sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendShootBookingNotificationToPhotographer failed:', err);
  }
}

export async function sendShootBookingAcceptedToPhotographer(params: {
  toEmail: string;
  photographerName: string;
  consumerName: string;
  shootType: string;
  bookingId: string;
  date: string;
  time: string;
}): Promise<void> {
  try {
    const html = wrapEmail(`
      ${emailHeader('Booking Confirmed ✅', `You confirmed the shoot with ${params.consumerName}.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Client', params.consumerName, true)}
          ${detailRow('Shoot Type', params.shootType, false)}
          ${detailRow('Date', params.date, true)}
          ${detailRow('Time', params.time, false)}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:12px 32px 4px;">
        <p style="color:#888888;font-size:13px;margin:0;">Payment will be transferred to your account after the session.</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Booking Confirmed — ${params.consumerName}`, html);
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
  date: string;
  reason?: string;
}): Promise<void> {
  try {
    const html = wrapEmail(`
      ${emailHeader('Booking Declined', `You declined the request from ${params.consumerName}.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Client', params.consumerName, true)}
          ${detailRow('Shoot Type', params.shootType, false)}
          ${detailRow('Date', params.date, true)}
          ${params.reason ? detailRow('Reason', params.reason, false) : ''}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0;">The client has not been charged. The time slot has been released.</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Booking Declined — ${params.consumerName}`, html);
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
  date: string;
  time: string;
}): Promise<void> {
  try {
    const html = wrapEmail(`
      ${emailHeader('Booking Canceled', `${params.consumerName} has canceled their session with you.`)}
      <tr><td style="background:#1A1A1A;padding:0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          ${detailRow('Client', params.consumerName, true)}
          ${detailRow('Shoot Type', params.shootType, false)}
          ${detailRow('Date', params.date, true)}
          ${detailRow('Time', params.time, false)}
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:16px 32px;">
        <p style="color:#888888;font-size:13px;margin:0;">The slot has been released and is now available for new bookings.</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/bookings')}
      ${emailFooter()}
    `);
    await sendBrandedEmail(params.toEmail, `Your Booking Was Canceled — ${params.consumerName}`, html);
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
    await sendBrandedEmail(params.toEmail, `Booking Request Expired`, html);
    console.log(`[Email] Shoot booking expiry notification sent to photographer ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendShootBookingExpiredToPhotographer failed:', err);
  }
}

export async function sendOrderConfirmationToConsumer(params: {
  toEmail: string;
  consumerName: string;
  orderId: string;
  orderNumber: number;
  items: Array<{
    productName: string;
    vendorName: string;
    vendorContactEmail?: string;
    quantity: number;
    basePrice: number;
  }>;
}): Promise<void> {
  try {
    const orderRef = `#${String(params.orderNumber).padStart(4, '0')}`;
    let grandTotal = 0;

    const itemCards = params.items.map(item => {
      const itemBase = item.basePrice * item.quantity;
      const upcharge = itemBase * 0.08;
      const itemTotal = itemBase + upcharge;
      grandTotal += itemTotal;
      return `<tr style="background:#1E1E1E;">
        <td style="padding:12px 14px;border-bottom:1px solid #2A2A2A;">
          <div style="color:#FFFFFF;font-size:14px;font-weight:600;">${item.productName}</div>
          <div style="color:#888888;font-size:12px;margin-top:2px;">by ${item.vendorName} &nbsp;·&nbsp; Qty: ${item.quantity} &nbsp;·&nbsp; ${cents(itemTotal)}</div>
        </td>
      </tr>`;
    }).join('');

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
          ${detailRow('Order Total', cents(grandTotal), true)}
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
    await sendBrandedEmail(params.toEmail, `🎉 Order confirmed — ${subjectItem}`, html);
    console.log(`[Email] Order confirmation sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendOrderConfirmationToConsumer failed:', err);
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
    quantity: number;
    basePrice: number;
  }>;
}): Promise<void> {
  try {
    const orderRef = `#${String(params.orderNumber).padStart(4, '0')}`;
    const customerDisplay = params.consumerDisplayName || params.consumerName;
    const usernameDisplay = params.consumerUsername ? `@${params.consumerUsername}` : '';

    let totalPayout = 0;
    const itemRows = params.items.map((item, i) => {
      const itemBase = item.basePrice * item.quantity;
      const fee = itemBase * 0.02;
      const payout = itemBase - fee;
      totalPayout += payout;
      const bg = i % 2 === 0 ? '#1A1A1A' : '#212121';
      return `<tr style="background:${bg};">
        <td style="padding:10px 14px;color:#FFFFFF;font-size:13px;">${item.productName}</td>
        <td style="padding:10px 14px;color:#888888;font-size:13px;text-align:center;">${item.quantity}</td>
        <td style="padding:10px 14px;color:#E8B930;font-size:13px;text-align:right;">${cents(payout)}</td>
      </tr>`;
    }).join('');

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
            <th style="padding:8px 14px;color:#E8B930;font-size:12px;text-align:right;font-weight:600;">Your Payout</th>
          </tr>
          ${itemRows}
          <tr style="background:#1E2E2A;">
            <td colspan="2" style="padding:10px 14px;color:#E8B930;font-size:14px;font-weight:700;">Total Payout</td>
            <td style="padding:10px 14px;color:#E8B930;font-size:14px;font-weight:700;text-align:right;">${cents(totalPayout)}</td>
          </tr>
        </table>
        <p style="color:#555555;font-size:12px;margin:8px 0 0 0;">Outsyde platform fee: 2% per item</p>
      </td></tr>
      ${emailCta('View in Dashboard', 'https://goutsyde.com/vendor/orders')}
      ${emailFooter()}
    `);

    const subjectItem = params.items[0]?.productName || 'an item';
    const subjectSuffix = params.items.length > 1 ? ' + more' : '';
    await sendBrandedEmail(params.toEmail, `🎉 New order received — ${subjectItem}${subjectSuffix}`, html);
    console.log(`[Email] Order vendor notification sent to ${params.toEmail}`);
  } catch (err) {
    console.error('[Email] sendOrderNotificationToVendor failed:', err);
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
}): Promise<void> {
  const OPS_EMAIL = 'info@goutsyde.com';
  try {
    const totalBase = params.basePrice ?? (params.items?.reduce((s, i) => s + i.basePrice * i.quantity, 0) ?? 0);
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
      detailRow('Base Amount', cents(totalBase), true),
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

    await sendBrandedEmail(OPS_EMAIL, `[Outsyde] ${params.eventType} — ${params.bookingOrOrderId}`, html);
    console.log(`[Email] Internal alert sent for: ${params.eventType} ${params.bookingOrOrderId}`);
  } catch (err) {
    console.error('[Email] sendInternalEventAlert failed:', err);
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
    await sendBrandedEmail(params.toEmail, subject, html);
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

  await sendAdminEmail({ to: params.adminEmail, subject, html });
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
}): Promise<void> {
  try {
    const expiryStr = params.expiresAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
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
    await sendBrandedEmail(params.toEmail, `Booking request received — ${params.serviceName}`, html);
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
}): Promise<void> {
  try {
    const vendorFee = params.basePrice * 0.02;
    const vendorPayout = params.basePrice - vendorFee;
    const expiryStr = params.expiresAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
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
    await sendBrandedEmail(params.toEmail, `New booking request — ${params.serviceName} on ${params.date}`, html);
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
    await sendBrandedEmail(params.toEmail, `Booking accepted — ${params.serviceName} on ${params.date}`, html);
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
    await sendBrandedEmail(params.toEmail, subject, html);
  } catch (err) {
    console.error('[Email] sendBookingDeclinedToConsumer failed:', err);
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
  const OPS_EMAIL = 'info@goutsyde.com';
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
    await sendAdminEmail({ to: OPS_EMAIL, subject: subjects[params.type], html });
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
  await sendBrandedEmail(params.toEmail, subject, html);
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
  await sendBrandedEmail(params.toEmail, subject, html);
}

// XO Beauty & Lashes — deposit booking confirmation to customer
export async function sendBookingConfirmationToCustomer(params: {
  toEmail: string
  customerName: string
  serviceName: string
  date: string
  time: string
  appointmentId: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[XO Email] RESEND_API_KEY not set — skipping customer confirmation')
    return
  }

  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)

  const subject = `Your appointment is confirmed — XO Beauty & Lashes`
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;">
      <div style="background:linear-gradient(135deg,#2e1a47,#c9b1d9);padding:32px;text-align:center;">
        <h1 style="color:white;margin:0;font-size:22px;letter-spacing:-0.3px;">XO Beauty &amp; Lashes</h1>
        <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px;">Your ritual is confirmed</p>
      </div>
      <div style="padding:32px;">
        <p style="font-size:15px;color:#1a0f2e;margin:0 0 24px;">Hi ${params.customerName},</p>
        <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 24px;">
          Your appointment has been confirmed. Nik will reach out if anything changes. See you soon!
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
        <div style="background:#f0fdf9;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.1em;color:#888;">AFTERCARE REMINDER</p>
          <ul style="margin:0;padding-left:16px;color:#555;font-size:13px;line-height:1.7;">
            <li>No water, steam, or heat for 3 hours after your appointment</li>
            <li>Avoid oil-based products near your eyes</li>
            <li>Never use a lash curler on extensions</li>
            <li>Brush daily with a clean spoolie</li>
          </ul>
        </div>
        <p style="font-size:13px;color:#888;text-align:center;">Questions? Reply to this email or DM us on Instagram.</p>
      </div>
      <div style="background:#f5f5f5;padding:16px;text-align:center;">
        <p style="margin:0;font-size:12px;color:#999;">XO Beauty &amp; Lashes · fleekbynik@gmail.com</p>
      </div>
    </div>
  `

  await resend.emails.send({
    from: 'XO Beauty & Lashes <bookings@xobeautyandlashes.com>',
    to: params.toEmail,
    subject,
    html,
  }).catch(err => console.error('[XO Email] Customer confirmation failed:', err))
}

// XO Beauty & Lashes — new booking alert to Nik (vendor)
export async function sendNewBookingAlertToVendor(params: {
  customerName: string
  customerEmail: string
  serviceName: string
  date: string
  time: string
  appointmentId: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[XO Email] RESEND_API_KEY not set — skipping vendor alert')
    return
  }

  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)

  const subject = `New booking: ${params.customerName} — ${params.serviceName}`
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;">
      <div style="background:linear-gradient(135deg,#2e1a47,#c9b1d9);padding:32px;text-align:center;">
        <h1 style="color:white;margin:0;font-size:22px;">New Booking</h1>
        <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px;">XO Beauty &amp; Lashes</p>
      </div>
      <div style="padding:32px;">
        <p style="font-size:15px;color:#1a0f2e;margin:0 0 24px;">Hey Nik! A new appointment has been booked.</p>
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
        <p style="font-size:13px;color:#888;text-align:center;">A $25 deposit was collected to secure this slot.</p>
      </div>
      <div style="background:#f5f5f5;padding:16px;text-align:center;">
        <p style="margin:0;font-size:12px;color:#999;">XO Beauty &amp; Lashes Dashboard</p>
      </div>
    </div>
  `

  await resend.emails.send({
    from: 'XO Beauty & Lashes <bookings@xobeautyandlashes.com>',
    to: 'fleekbynik@gmail.com',
    subject,
    html,
  }).catch(err => console.error('[XO Email] Vendor alert failed:', err))
}
