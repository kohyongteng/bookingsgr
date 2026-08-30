const { createGuestPasscode } = require('./create-guest-passcode.js');

// CHANGE THESE before running:
const TEST_UNIT = 'S1503';       // pick a unit that's safe to test on (vacant, no current guest)
const TEST_GUEST_NAME = 'Test Guest - Claude';
const TEST_CHECKIN_DATE = '2026-08-06';  // "YYYY-MM-DD" - today or near future
const TEST_CHECKOUT_DATE = '2026-08-07';

(async () => {
  try {
    console.log(`Creating test passcode for ${TEST_UNIT}...`);
    const result = await createGuestPasscode(TEST_UNIT, TEST_GUEST_NAME, TEST_CHECKIN_DATE, TEST_CHECKOUT_DATE);

    console.log('\n✅ SUCCESS\n');
    console.log('Unit:', result.unit);
    console.log('System:', result.system);
    console.log('Passcode:', result.passcode);
    console.log('Effective:', new Date(result.effectiveTime).toISOString());
    console.log('Invalid:', new Date(result.invalidTime).toISOString());
    console.log('Outbox file written to:', result.outboxFile);
    console.log('\n--- WhatsApp message content ---\n');
    console.log(result.whatsappMessage);
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
})();
