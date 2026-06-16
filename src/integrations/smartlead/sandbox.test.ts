import { describe, expect, it } from 'vitest';
import { classifyWarmth, mapWarmupStatus } from '../../agents/sending/mailbox-sync.js';
import { AppError } from '../../lib/errors.js';
import { createSandboxSmartleadClient, SANDBOX_ACCOUNT_ID, SANDBOX_FROM_EMAIL } from './sandbox.js';

describe('createSandboxSmartleadClient', () => {
  const sandbox = createSandboxSmartleadClient();

  it('lists one unmistakably-demo account (sentinel id + reserved .example domain)', async () => {
    const accounts = await sandbox.listEmailAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toBe(SANDBOX_ACCOUNT_ID);
    expect(accounts[0]?.from_email).toBe(SANDBOX_FROM_EMAIL);
    expect(SANDBOX_FROM_EMAIL.endsWith('.example')).toBe(true); // non-deliverable by construction
  });

  it('first sync maps the demo account to "warming", never directly to "warm"', async () => {
    const [account] = await sandbox.listEmailAccounts();
    expect(mapWarmupStatus(account?.warmup_details)).toBe('warming');
  });

  it('warmup stats clear the REAL classifyWarmth thresholds → promotes to "warm"', async () => {
    const stats = await sandbox.getWarmupStats(SANDBOX_ACCOUNT_ID);
    const reputation = { sent: stats.sent_count ?? 0, spam: stats.spam_count ?? 0 };
    // warmupActive=true (mailbox is 'warming' after first sync); the real classifier promotes it.
    expect(classifyWarmth(reputation, true)).toBe('warm');
  });

  it('refuses every write/send method with a smartlead_sandbox error (never fakes a real action)', async () => {
    const expectRefusal = async (p: Promise<unknown>) => {
      await expect(p).rejects.toMatchObject({ code: 'smartlead_sandbox' });
      await expect(p).rejects.toBeInstanceOf(AppError);
    };
    await expectRefusal(sandbox.createCampaign('demo'));
    await expectRefusal(sandbox.saveSequence('c', 's', 'b'));
    await expectRefusal(sandbox.assignEmailAccounts('c', ['a']));
    await expectRefusal(sandbox.setSchedule('c', 20));
    await expectRefusal(sandbox.setStatus('c', 'START'));
    await expectRefusal(sandbox.addLead('c', { email: 'x@y.example', custom_fields: {} }));
    await expectRefusal(
      sandbox.sendReply('c', {
        email: 'x@y.example',
        subject: 's',
        body: 'b',
        inReplyToMessageId: null,
      }),
    );
  });
});
