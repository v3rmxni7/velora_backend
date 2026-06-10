// Safe fallback draft — rendered in CODE (string interpolation), so it can NEVER contain a
// model-guessed fact. Allowed variables: ONLY first_name and company_name read verbatim from
// the lead row, plus a STATIC org-level value prop (same for every lead — not lead-specific).
// Forbidden by construction: any per-lead claim, numbers, %, $, titles, "I noticed/saw…".

export interface TemplateLead {
  firstName?: string;
  companyName?: string;
}

export function renderTemplate(
  lead: TemplateLead,
  valueProp: string,
): { subject: string; body: string } {
  const greeting = lead.firstName ? `Hi ${lead.firstName},` : 'Hi there,';
  const companyClause = lead.companyName ? ` at ${lead.companyName}` : '';
  const vp = valueProp.trim() || 'helping teams like yours work more efficiently';
  const subject = lead.companyName ? `Quick idea for ${lead.companyName}` : 'Quick idea';
  const body = `${greeting}\n\nI work with teams${companyClause} on ${vp}. Would you be open to a brief chat this week?`;
  return { subject, body };
}
