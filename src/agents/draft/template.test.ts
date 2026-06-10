import { describe, expect, it } from 'vitest';
import { renderTemplate } from './template.js';

describe('renderTemplate (safe fallback)', () => {
  it('uses first_name and company_name when present', () => {
    const { subject, body } = renderTemplate(
      { firstName: 'Alex', companyName: 'Nimbus Labs' },
      'developer onboarding',
    );
    expect(body.startsWith('Hi Alex,')).toBe(true);
    expect(body).toContain('at Nimbus Labs');
    expect(subject).toContain('Nimbus Labs');
  });

  it('falls back to a generic greeting when first_name is missing', () => {
    const { body } = renderTemplate({ companyName: 'Acme' }, 'x');
    expect(body.startsWith('Hi there,')).toBe(true);
  });

  it('omits the company clause when company_name is missing', () => {
    const { body, subject } = renderTemplate({ firstName: 'Sam' }, 'x');
    expect(body).not.toContain(' at ');
    expect(subject).toBe('Quick idea');
  });

  it('never contains a hard claim (no %, $, or long numbers) — only safe vars + static copy', () => {
    const { body } = renderTemplate({ firstName: 'Sam', companyName: 'Acme' }, 'better workflows');
    expect(/[%$]|\d{4,}/.test(body)).toBe(false);
  });
});
