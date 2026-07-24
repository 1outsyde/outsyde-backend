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
  const { client } = await getUncachableResendClient();
  const result = await client.emails.send({ from: FROM_ORDERS, to, subject, html });
  if (result.error) {
    throw new Error(`Resend error: ${JSON.stringify(result.error)}`);
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

export async function sendAppointmentConfirmationToConsumer(params: {
  to: string;
  customerName: string;
  businessName: string;
  date: string;
  time: string;
  totalPrice: number;
}): Promise<void> {
  try {
    const html = buildEmailShell(
      'Your Appointment is Confirmed!',
      [
        { label: 'Customer', value: params.customerName },
        { label: 'Business', value: params.businessName },
        { label: 'Date', value: params.date },
        { label: 'Time', value: params.time },
        { label: 'Total', value: `$${(params.totalPrice / 100).toFixed(2)}` },
      ],
    );
    await sendBrandedEmail(params.to, `Appointment Confirmed — ${params.businessName}`, html);
    console.log(`[Email] Appointment confirmation sent to ${params.to}`);
  } catch (err) {
    console.error('[Email] sendAppointmentConfirmationToConsumer failed:', err);
  }
}

export async function sendAppointmentNotificationToVendor(params: {
  to: string;
  businessName: string;
  customerName: string;
  date: string;
  time: string;
  totalPrice: number;
}): Promise<void> {
  try {
    const html = buildEmailShell(
      'New Appointment Booked',
      [
        { label: 'Customer', value: params.customerName },
        { label: 'Date', value: params.date },
        { label: 'Time', value: params.time },
        { label: 'Total', value: `$${(params.totalPrice / 100).toFixed(2)}` },
      ],
    );
    await sendBrandedEmail(params.to, `New Appointment — ${params.customerName}`, html);
    console.log(`[Email] Appointment vendor notification sent to ${params.to}`);
  } catch (err) {
    console.error('[Email] sendAppointmentNotificationToVendor failed:', err);
  }
}

export async function sendShootBookingConfirmationToConsumer(params: {
  to: string;
  customerName: string;
  photographerName: string;
  date: string;
  time: string;
  shootType: string;
  totalPrice: number;
}): Promise<void> {
  try {
    const html = buildEmailShell(
      'Your Shoot Booking is Confirmed!',
      [
        { label: 'Customer', value: params.customerName },
        { label: 'Photographer', value: params.photographerName },
        { label: 'Shoot Type', value: params.shootType },
        { label: 'Date', value: params.date },
        { label: 'Time', value: params.time },
        { label: 'Total', value: `$${(params.totalPrice / 100).toFixed(2)}` },
      ],
    );
    await sendBrandedEmail(params.to, `Shoot Booking Confirmed — ${params.photographerName}`, html);
    console.log(`[Email] Shoot confirmation sent to ${params.to}`);
  } catch (err) {
    console.error('[Email] sendShootBookingConfirmationToConsumer failed:', err);
  }
}

export async function sendShootBookingNotificationToPhotographer(params: {
  to: string;
  photographerName: string;
  customerName: string;
  date: string;
  time: string;
  shootType: string;
  totalPrice: number;
}): Promise<void> {
  try {
    const html = buildEmailShell(
      'New Shoot Booking',
      [
        { label: 'Client', value: params.customerName },
        { label: 'Shoot Type', value: params.shootType },
        { label: 'Date', value: params.date },
        { label: 'Time', value: params.time },
        { label: 'Total', value: `$${(params.totalPrice / 100).toFixed(2)}` },
      ],
    );
    await sendBrandedEmail(params.to, `New Shoot — ${params.customerName}`, html);
    console.log(`[Email] Shoot photographer notification sent to ${params.to}`);
  } catch (err) {
    console.error('[Email] sendShootBookingNotificationToPhotographer failed:', err);
  }
}

export async function sendOrderConfirmationToConsumer(params: {
  to: string;
  customerName: string;
  orderId: string;
  itemsSummary: string;
  totalAmount: number;
}): Promise<void> {
  try {
    const html = buildEmailShell(
      'Your Order is Confirmed!',
      [
        { label: 'Customer', value: params.customerName },
        { label: 'Order', value: `#${params.orderId.slice(-8).toUpperCase()}` },
        { label: 'Items', value: params.itemsSummary },
        { label: 'Total', value: `$${(params.totalAmount / 100).toFixed(2)}` },
      ],
    );
    await sendBrandedEmail(params.to, `Order Confirmed — #${params.orderId.slice(-8).toUpperCase()}`, html);
    console.log(`[Email] Order confirmation sent to ${params.to}`);
  } catch (err) {
    console.error('[Email] sendOrderConfirmationToConsumer failed:', err);
  }
}

export async function sendOrderNotificationToVendor(params: {
  to: string;
  vendorName: string;
  customerName: string;
  orderId: string;
  itemsSummary: string;
  totalAmount: number;
}): Promise<void> {
  try {
    const html = buildEmailShell(
      'New Order Received',
      [
        { label: 'Customer', value: params.customerName },
        { label: 'Order', value: `#${params.orderId.slice(-8).toUpperCase()}` },
        { label: 'Items', value: params.itemsSummary },
        { label: 'Total', value: `$${(params.totalAmount / 100).toFixed(2)}` },
      ],
    );
    await sendBrandedEmail(params.to, `New Order from ${params.customerName}`, html);
    console.log(`[Email] Order vendor notification sent to ${params.to}`);
  } catch (err) {
    console.error('[Email] sendOrderNotificationToVendor failed:', err);
  }
}

export async function sendInternalEventAlert(params: {
  eventType: string;
  summary: string;
  details: Record<string, string>;
}): Promise<void> {
  const OPS_EMAIL = 'info@goutsyde.com';
  try {
    const rows = Object.entries(params.details).map(([label, value]) => ({ label, value }));
    const html = buildEmailShell(`[Outsyde Internal] ${params.eventType}`, [
      { label: 'Summary', value: params.summary },
      ...rows,
    ]);
    await sendBrandedEmail(OPS_EMAIL, `[Outsyde] ${params.eventType}`, html);
    console.log(`[Email] Internal alert sent for event: ${params.eventType}`);
  } catch (err) {
    console.error('[Email] sendInternalEventAlert failed:', err);
  }
}
