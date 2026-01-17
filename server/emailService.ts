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
